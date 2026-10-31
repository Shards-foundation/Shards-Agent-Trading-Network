import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKeyInput,
} from "node:crypto";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Explicitly configured signing algorithm. Default stays RS256 for existing providers. */
  algorithm?: "RS256" | "EdDSA";
  clockToleranceSeconds?: number;
  jwksCacheTtlMs?: number;
}

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  audience: string[];
  expiresAt: number;
}

interface Jwk {
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  n?: string;
  e?: string;
  kty?: string;
  crv?: string;
  x?: string;
}
interface JwkSet {
  keys: Jwk[];
}

type JwksFetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface CacheEntry {
  keys: JwkSet["keys"];
  expiresAt: number;
}

const jwksCache = new Map<string, CacheEntry>();

function decodeSegment(segment: string): Buffer {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment))
    throw new Error("Malformed JWT segment.");
  return Buffer.from(segment, "base64url");
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSegment(segment).toString("utf8")) as unknown;
  } catch {
    throw new Error("Malformed JWT JSON.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Malformed JWT JSON.");
  return decoded as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  return null;
}

async function loadJwks(
  url: string,
  fetcher: JwksFetcher,
  nowMs: number,
  ttlMs: number,
  forceRefresh = false,
): Promise<JwkSet["keys"]> {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > nowMs) return cached.keys;

  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error("OIDC key service returned a non-success status.");
  const payload = (await response.json()) as unknown;
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { keys?: unknown }).keys)
  ) {
    throw new Error("OIDC key service returned an invalid JWKS document.");
  }
  const keys = (payload as { keys: unknown[] }).keys.filter(
    (key): key is JwkSet["keys"][number] => {
      if (!key || typeof key !== "object" || Array.isArray(key)) return false;
      const candidate = key as Record<string, unknown>;
      return (
        typeof candidate.kid === "string" &&
        ((candidate.kty === "RSA" &&
          typeof candidate.n === "string" &&
          typeof candidate.e === "string") ||
          (candidate.kty === "OKP" &&
            candidate.crv === "Ed25519" &&
            typeof candidate.x === "string"))
      );
    },
  );
  if (keys.length === 0)
    throw new Error("OIDC key service has no usable signing keys.");
  jwksCache.set(url, { keys, expiresAt: nowMs + ttlMs });
  return keys;
}

function validateHttpsUrl(urlValue: string, label: string): void {
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  ) {
    throw new Error(`${label} must use HTTPS.`);
  }
}

export async function verifyOidcAccessToken(
  token: string,
  config: OidcConfig,
  options: { fetcher?: JwksFetcher; nowMs?: number } = {},
): Promise<VerifiedOidcIdentity> {
  if (
    !config.issuer.trim() ||
    !config.audience.trim() ||
    !config.jwksUrl.trim()
  )
    throw new Error("OIDC issuer, audience and JWKS URL are required.");
  validateHttpsUrl(config.issuer, "OIDC issuer");
  if (token.length > 16_384) throw new Error("OIDC access token is too large.");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Malformed JWT.");
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [
    string,
    string,
    string,
  ];
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedPayload);
  const algorithm = config.algorithm ?? "RS256";
  if (algorithm !== "RS256" && algorithm !== "EdDSA") {
    throw new Error("Unsupported configured OIDC signing algorithm.");
  }
  if (
    header.alg !== algorithm ||
    typeof header.kid !== "string" ||
    !header.kid
  ) {
    throw new Error(`Only kid-addressed ${algorithm} JWTs are accepted.`);
  }

  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const tolerance = config.clockToleranceSeconds ?? 5;
  const audience = asStringArray(claims.aud);
  if (claims.iss !== config.issuer) throw new Error("OIDC issuer mismatch.");
  if (!audience || !audience.includes(config.audience))
    throw new Error("OIDC audience mismatch.");
  if (
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    claims.sub.length > 512
  )
    throw new Error("OIDC subject is invalid.");
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds - tolerance
  ) {
    throw new Error("OIDC token is expired or has no valid expiry.");
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== "number" ||
      !Number.isFinite(claims.nbf) ||
      claims.nbf > nowSeconds + tolerance)
  ) {
    throw new Error("OIDC token is not yet valid.");
  }

  validateHttpsUrl(config.jwksUrl, "OIDC JWKS URL");
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const ttlMs = config.jwksCacheTtlMs ?? 300_000;
  let keys = await loadJwks(config.jwksUrl, fetcher, nowMs, ttlMs);
  // Pin both the algorithm and the JWK key type, preventing JWT alg confusion.
  const acceptable = (key: Jwk): boolean =>
    key.kid === header.kid &&
    (!key.alg || key.alg === algorithm) &&
    (!key.use || key.use === "sig") &&
    (!key.key_ops || key.key_ops.includes("verify")) &&
    (algorithm === "RS256"
      ? key.kty === "RSA" &&
        typeof key.n === "string" &&
        typeof key.e === "string"
      : key.kty === "OKP" &&
        key.crv === "Ed25519" &&
        typeof key.x === "string");
  let jwk = keys.find(acceptable);
  if (!jwk) {
    keys = await loadJwks(config.jwksUrl, fetcher, nowMs, ttlMs, true);
    jwk = keys.find(acceptable);
  }
  if (!jwk) throw new Error("No acceptable signing key matched the token.");

  const publicKey =
    algorithm === "RS256"
      ? (() => {
          if (
            !jwk.n ||
            !jwk.e ||
            Buffer.from(jwk.n, "base64url").length < 256
          ) {
            throw new Error("No acceptable RSA signing key matched the token.");
          }
          return createPublicKey({
            key: { kty: "RSA", n: jwk.n, e: jwk.e },
            format: "jwk",
          } as unknown as JsonWebKeyInput);
        })()
      : (() => {
          if (
            !jwk.x ||
            !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
            Buffer.from(jwk.x, "base64url").length !== 32
          ) {
            throw new Error(
              "No acceptable Ed25519 signing key matched the token.",
            );
          }
          return createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
            format: "jwk",
          } as unknown as JsonWebKeyInput);
        })();
  const signature = decodeSegment(encodedSignature);
  const signedContent = Buffer.from(
    `${encodedHeader}.${encodedPayload}`,
    "utf8",
  );
  if (
    !verifySignature(
      algorithm === "RS256" ? "RSA-SHA256" : null,
      signedContent,
      publicKey,
      signature,
    )
  ) {
    throw new Error("OIDC token signature verification failed.");
  }

  return {
    issuer: claims.iss,
    subject: claims.sub,
    audience,
    expiresAt: claims.exp,
  };
}

export function clearOidcJwksCacheForTests(): void {
  jwksCache.clear();
}
