import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

export interface IdTokenValidationConfig {
  issuer: string;
  clientId: string;
  jwksUrl: string;
  algorithm: "RS256" | "EdDSA";
}

type JsonRecord = Record<string, unknown>;
type JwkFetcher = (input: string, init: RequestInit) => Promise<Response>;

function jsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodePart(part: string): JsonRecord {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part))
    throw new Error("Invalid ID token encoding");
  const raw = Buffer.from(part, "base64url");
  if (raw.toString("base64url") !== part || raw.length > 8192)
    throw new Error("Invalid ID token encoding");
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (!jsonRecord(value)) throw new Error("Invalid ID token claims");
  return value;
}

function safeEqual(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

function trustedHttpsUrl(raw: string): URL {
  const value = new URL(raw);
  if (
    value.protocol !== "https:" ||
    !value.hostname ||
    value.username ||
    value.password ||
    value.hash ||
    value.search
  )
    throw new Error("OIDC issuer or JWKS endpoint is not trusted");
  return value;
}

export function idTokenConfig(clientId: string): IdTokenValidationConfig {
  const {
    OIDC_ISSUER,
    OIDC_JWKS_URL,
    OIDC_ID_TOKEN_ALGORITHM = "RS256",
  } = process.env;
  if (!OIDC_ISSUER || !OIDC_JWKS_URL || !clientId)
    throw new Error("OIDC identity verification is not configured");
  trustedHttpsUrl(OIDC_ISSUER);
  trustedHttpsUrl(OIDC_JWKS_URL);
  if (
    OIDC_ID_TOKEN_ALGORITHM !== "RS256" &&
    OIDC_ID_TOKEN_ALGORITHM !== "EdDSA"
  )
    throw new Error("Unsupported OIDC ID token signing algorithm");
  return {
    issuer: OIDC_ISSUER,
    clientId,
    jwksUrl: OIDC_JWKS_URL,
    algorithm: OIDC_ID_TOKEN_ALGORITHM,
  };
}

/**
 * Validate an OIDC authorisation-code-flow ID token BEFORE session issuance.
 * The ID token has client_id audience, not the backend API's resource audience.
 * Only configured JWKS keys are used; JOSE header URL/key overrides are refused.
 */
export async function verifyIdToken(
  token: unknown,
  nonce: string,
  accessToken: string,
  config: IdTokenValidationConfig,
  options: { fetcher?: JwkFetcher; nowMs?: number } = {},
): Promise<void> {
  if (typeof token !== "string" || token.length > 16384)
    throw new Error("Missing or oversized OIDC ID token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token format");
  const [headerPart, bodyPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = decodePart(headerPart);
  const claims = decodePart(bodyPart);
  if (
    header.alg !== config.algorithm ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 256 ||
    ["jwk", "jku", "x5u", "x5c", "crit"].some(
      (name) => Object.hasOwn(header, name),
    )
  )
    throw new Error("Untrusted ID token signature header");

  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const audience =
    typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) &&
          claims.aud.length > 0 &&
          claims.aud.length <= 8 &&
          claims.aud.every((value) => typeof value === "string")
        ? (claims.aud as string[])
        : [];
  if (claims.iss !== config.issuer)
    throw new Error("OIDC ID token issuer mismatch");
  if (
    !audience.includes(config.clientId) ||
    (audience.length > 1 && claims.azp !== config.clientId) ||
    (claims.azp !== undefined && claims.azp !== config.clientId)
  )
    throw new Error("OIDC ID token audience mismatch");
  if (
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    claims.sub.length > 512
  )
    throw new Error("Missing OIDC subject");
  if (
    typeof claims.nonce !== "string" ||
    !nonce ||
    !safeEqual(claims.nonce, nonce)
  )
    throw new Error("OIDC nonce mismatch");
  if (
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now - 5 ||
    typeof claims.iat !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > now + 60 ||
    claims.iat < now - 900 ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" ||
        !Number.isSafeInteger(claims.nbf) ||
        claims.nbf > now + 60))
  )
    throw new Error("OIDC ID token time window invalid");

  // In code flow at_hash is optional. If present, validate against the
  // access token. For unsupported EdDSA at_hash semantics fail closed.
  if (claims.at_hash !== undefined) {
    if (config.algorithm !== "RS256" || typeof claims.at_hash !== "string")
      throw new Error("Unsupported ID token access token hash");
    const digest = createHash("sha256").update(accessToken, "ascii").digest();
    if (
      !safeEqual(
        claims.at_hash,
        digest.subarray(0, digest.length / 2).toString("base64url"),
      )
    )
      throw new Error("OIDC access token hash mismatch");
  }

  trustedHttpsUrl(config.issuer);
  const jwks = trustedHttpsUrl(config.jwksUrl);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(jwks.toString(), {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error("OIDC signing key service unavailable");
  const payloadText = await response.text();
  if (payloadText.length > 65536)
    throw new Error("Oversized OIDC signing key set");
  const payload: unknown = JSON.parse(payloadText);
  if (
    !jsonRecord(payload) ||
    !Array.isArray(payload.keys) ||
    payload.keys.length > 32
  )
    throw new Error("Invalid OIDC signing key set");

  const acceptable = payload.keys.filter((value: unknown) => {
    if (!jsonRecord(value)) return false;
    return (
      value.kid === header.kid &&
      (value.alg === undefined || value.alg === config.algorithm) &&
      (value.use === undefined || value.use === "sig") &&
      (value.key_ops === undefined ||
        (Array.isArray(value.key_ops) && value.key_ops.includes("verify"))) &&
      (config.algorithm === "RS256"
        ? value.kty === "RSA" &&
          typeof value.n === "string" &&
          typeof value.e === "string"
        : value.kty === "OKP" &&
          value.crv === "Ed25519" &&
          typeof value.x === "string")
    );
  });
  if (acceptable.length !== 1)
    throw new Error("No unique trusted OIDC signing key");
  const jwk = acceptable[0] as JsonRecord;
  const key =
    config.algorithm === "RS256"
      ? (() => {
          const modulus = Buffer.from(jwk.n as string, "base64url");
          if (modulus.length < 256 || modulus.length > 1024)
            throw new Error("OIDC signing key strength invalid");
          return createPublicKey({
            key: {
              kty: "RSA",
              n: jwk.n as string,
              e: jwk.e as string,
            },
            format: "jwk",
          });
        })()
      : (() => {
          const publicBytes = Buffer.from(jwk.x as string, "base64url");
          if (publicBytes.length !== 32)
            throw new Error("OIDC Ed25519 signing key invalid");
          return createPublicKey({
            key: {
              kty: "OKP",
              crv: "Ed25519",
              x: jwk.x as string,
            },
            format: "jwk",
          });
        })();
  if (
    !signaturePart ||
    !/^[A-Za-z0-9_-]+$/.test(signaturePart) ||
    !verifySignature(
      config.algorithm === "RS256" ? "RSA-SHA256" : null,
      Buffer.from(`${headerPart}.${bodyPart}`, "ascii"),
      key,
      Buffer.from(signaturePart, "base64url"),
    )
  )
    throw new Error("OIDC ID token signature invalid");
}
