import { createPublicKey, verify as verifySignature, type JsonWebKeyInput } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  clockToleranceSeconds?: number;
  jwksCacheTtlMs?: number;
}

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  audience: string[];
  expiresAt: number;
}

interface JwkSet {
  keys: Array<JsonWebKeyInput & {
    kid?: string;
    alg?: string;
    use?: string;
    key_ops?: string[];
    n?: string;
    e?: string;
    kty?: string;
  }>;
}

type JwksFetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface CacheEntry {
  keys: JwkSet["keys"];
  expiresAt: number;
}

const jwksCache = new Map<string, CacheEntry>();

function decodeSegment(segment: string): Buffer {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Malformed JWT segment.");
  return Buffer.from(segment, "base64url");
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const decoded = JSON.parse(decodeSegment(segment).toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Malformed JWT JSON.");
  return decoded as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return null;
}

async function loadJwks(
  url: string,
  fetcher: JwksFetcher,
  nowMs: number,
  ttlMs: number,
  forceRefresh = false
): Promise<JwkSet["keys"]> {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > nowMs) return cached.keys;

  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("OIDC key service returned a non-success status.");
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { keys?: unknown }).keys)) {
    throw new Error("OIDC key service returned an invalid JWKS document.");
  }
  const keys = (payload as { keys: unknown[] }).keys.filter((key): key is JwkSet["keys"][number] => {
    if (!key || typeof key !== "object" || Array.isArray(key)) return false;
    const candidate = key as Record<string, unknown>;
    return candidate.kty === "RSA" && typeof candidate.kid === "string" &&
      typeof candidate.n === "string" && typeof candidate.e === "string";
  });
  if (keys.length === 0) throw new Error("OIDC key service has no usable RSA signing keys.");
  jwksCache.set(url, { keys, expiresAt: nowMs + ttlMs });
  return keys;
}

function validateHttpsUrl(urlValue: string, label: string): void {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error(`${label} must use HTTPS.`);
  }
}

export async function verifyOidcAccessToken(
  token: string,
  config: OidcConfig,
  options: { fetcher?: JwksFetcher; nowMs?: number } = {}
): Promise<VerifiedOidcIdentity> {
  if (!config.issuer.trim() || !config.audience.trim() || !config.jwksUrl.trim()) throw new Error("OIDC issuer, audience and JWKS URL are required.");
  validateHttpsUrl(config.issuer, "OIDC issuer");
  if (token.length > 16_384) throw new Error("OIDC access token is too large.");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Malformed JWT.");
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new Error("Only kid-addressed RS256 JWTs are accepted.");
  }

  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const tolerance = config.clockToleranceSeconds ?? 5;
  const audience = asStringArray(claims.aud);
  if (claims.iss !== config.issuer) throw new Error("OIDC issuer mismatch.");
  if (!audience || !audience.includes(config.audience)) throw new Error("OIDC audience mismatch.");
  if (typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 512) throw new Error("OIDC subject is invalid.");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds - tolerance) {
    throw new Error("OIDC token is expired or has no valid expiry.");
  }
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + tolerance)) {
    throw new Error("OIDC token is not yet valid.");
  }

  validateHttpsUrl(config.jwksUrl, "OIDC JWKS URL");
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const ttlMs = config.jwksCacheTtlMs ?? 300_000;
  let keys = await loadJwks(config.jwksUrl, fetcher, nowMs, ttlMs);
  let jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify")));
  if (!jwk) {
    keys = await loadJwks(config.jwksUrl, fetcher, nowMs, ttlMs, true);
    jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify")));
  }
  if (!jwk || !jwk.n || Buffer.from(jwk.n, "base64url").length < 256) {
    throw new Error("No acceptable RSA signing key matched the token.");
  }

  const publicKey = createPublicKey({ key: jwk as JsonWebKeyInput, format: "jwk" });
  const signature = decodeSegment(encodedSignature);
  const signedContent = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  if (!verifySignature("RSA-SHA256", signedContent, publicKey, signature)) {
    throw new Error("OIDC token signature verification failed.");
  }

  return {
    issuer: claims.iss,
    subject: claims.sub,
    audience,
    expiresAt: claims.exp
  };
}

export function clearOidcJwksCacheForTests(): void {
  jwksCache.clear();
}
