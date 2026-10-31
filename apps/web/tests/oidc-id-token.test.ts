import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/auth/callback/route";
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  SESSION_COOKIE,
} from "../app/lib/auth-session";
import {
  verifyIdToken,
  type IdTokenValidationConfig,
} from "../app/lib/oidc-id-token";

const issuer = "https://identity.example.test/";
const jwksUrl = "https://identity.example.test/.well-known/jwks.json";
const clientId = "satns-web-client";
const nonce = "test-nonce-from-auth-request";
const state = "test-oauth-state";
const accessToken = "very-long-synthetic-access-token";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed = generateKeyPairSync("ed25519");
const rsaKey = {
  ...rsa.publicKey.export({ format: "jwk" }),
  kid: "rsa-signing-key",
  use: "sig",
  alg: "RS256",
};
const edKey = {
  ...ed.publicKey.export({ format: "jwk" }),
  kid: "ed-signing-key",
  use: "sig",
  alg: "EdDSA",
};
const config: IdTokenValidationConfig = {
  issuer,
  clientId,
  jwksUrl,
  algorithm: "RS256",
};

function signedIdToken({
  algorithm = "RS256",
  claims = {},
  header = {},
}: {
  algorithm?: "RS256" | "EdDSA";
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
} = {}) {
  const jwtHeader = {
    alg: algorithm,
    kid: algorithm === "RS256" ? rsaKey.kid : edKey.kid,
    typ: "JWT",
    ...header,
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: "test-user",
    aud: clientId,
    exp: now + 600,
    iat: now,
    nonce,
    ...claims,
  };
  const data = [jwtHeader, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  const signature = sign(
    algorithm === "RS256" ? "RSA-SHA256" : null,
    Buffer.from(data),
    algorithm === "RS256" ? rsa.privateKey : ed.privateKey,
  );
  return `${data}.${signature.toString("base64url")}`;
}

function keyResponse(keys: unknown[] = [rsaKey]) {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const keyFetcher = async () => keyResponse();

describe("OIDC browser ID token validation", () => {
  it("accepts a signed RS256 token bound to the exact nonce", async () => {
    await expect(
      verifyIdToken(signedIdToken(), nonce, accessToken, config, {
        fetcher: keyFetcher,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a pinned Ed25519 signing key", async () => {
    await expect(
      verifyIdToken(
        signedIdToken({ algorithm: "EdDSA" }),
        nonce,
        accessToken,
        { ...config, algorithm: "EdDSA" },
        { fetcher: async () => keyResponse([edKey]) },
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["missing token", undefined, {}],
    ["wrong nonce", signedIdToken({ claims: { nonce: "attacker" } }), {}],
    [
      "wrong issuer",
      signedIdToken({ claims: { iss: "https://evil.test/" } }),
      {},
    ],
    ["wrong audience", signedIdToken({ claims: { aud: "other-client" } }), {}],
    ["expired", signedIdToken({ claims: { exp: 1 } }), {}],
    [
      "issued too far in future",
      signedIdToken({ claims: { iat: 9999999999 } }),
      {},
    ],
    ["unsigned alg header", signedIdToken({ header: { alg: "none" } }), {}],
    ["embedded key injection", signedIdToken({ header: { jwk: rsaKey } }), {}],
    [
      "multiple audiences missing azp",
      signedIdToken({ claims: { aud: [clientId, "someone-else"] } }),
      {},
    ],
    [
      "incorrect azp",
      signedIdToken({ claims: { azp: "attacker-client" } }),
      {},
    ],
  ])("rejects %s", async (_label, token, _options) => {
    await expect(
      verifyIdToken(token, nonce, accessToken, config, {
        fetcher: keyFetcher,
      }),
    ).rejects.toThrow();
  });

  it("rejects signature tampering, key substitution and HTTP JWKS", async () => {
    const original = signedIdToken();
    const parts = original.split(".");
    const corrupt = `${parts[0]}.${parts[1]}.${"A".repeat(342)}`;
    await expect(
      verifyIdToken(corrupt, nonce, accessToken, config, {
        fetcher: keyFetcher,
      }),
    ).rejects.toThrow();
    await expect(
      verifyIdToken(original, nonce, accessToken, config, {
        fetcher: async () => keyResponse([edKey]),
      }),
    ).rejects.toThrow();
    await expect(
      verifyIdToken(
        original,
        nonce,
        accessToken,
        { ...config, jwksUrl: "http://127.0.0.1/jwks" },
        { fetcher: keyFetcher },
      ),
    ).rejects.toThrow();
  });

  it("requires at_hash integrity when provided", async () => {
    const digest = createHash("sha256").update(accessToken, "ascii").digest();
    const atHash = digest.subarray(0, 16).toString("base64url");
    await expect(
      verifyIdToken(
        signedIdToken({ claims: { at_hash: atHash } }),
        nonce,
        accessToken,
        config,
        { fetcher: keyFetcher },
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyIdToken(
        signedIdToken({ claims: { at_hash: "wrong" } }),
        nonce,
        accessToken,
        config,
        { fetcher: keyFetcher },
      ),
    ).rejects.toThrow();
  });

  it("checks azp when the signed token has multiple audiences", async () => {
    await expect(
      verifyIdToken(
        signedIdToken({
          claims: { aud: [clientId, "second"], azp: clientId },
        }),
        nonce,
        accessToken,
        config,
        { fetcher: keyFetcher },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("OIDC callback fail-closed session creation", () => {
  beforeEach(() => {
    vi.stubEnv("OIDC_CLIENT_ID", clientId);
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.stubEnv("OIDC_JWKS_URL", jwksUrl);
    vi.stubEnv("OIDC_ID_TOKEN_ALGORITHM", "RS256");
    vi.stubEnv("OIDC_AUTHORIZATION_ENDPOINT", `${issuer}authorize`);
    vi.stubEnv("OIDC_TOKEN_ENDPOINT", `${issuer}token`);
    vi.stubEnv("AUTH_PUBLIC_ORIGIN", "https://satns.vercel.app");
    vi.stubEnv("SATN_API_INTERNAL_URL", "https://api.example.test");
    vi.stubEnv("SATN_SESSION_KEY", Buffer.alloc(32, 5).toString("base64url"));
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function callbackRequest() {
    return new NextRequest(
      `https://satns.vercel.app/api/auth/callback?state=${state}&code=abcdefghij`,
      {
        headers: {
          cookie: [
            `${OAUTH_STATE_COOKIE}=${state}`,
            `${OAUTH_VERIFIER_COOKIE}=test-verifier`,
            `${OAUTH_NONCE_COOKIE}=${nonce}`,
          ].join("; "),
        },
      },
    );
  }

  function stubExchange(idToken?: string) {
    const called: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        called.push(url);
        if (url.endsWith("/token"))
          return new Response(
            JSON.stringify({
              access_token: accessToken,
              expires_in: 3600,
              ...(idToken ? { id_token: idToken } : {}),
            }),
            { status: 200 },
          );
        if (url === jwksUrl) return keyResponse();
        if (url.endsWith("/v1/owners/me"))
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response("Unexpected request", { status: 503 });
      }),
    );
    return called;
  }

  it("refuses token exchange without id_token before owner API access", async () => {
    const called = stubExchange();
    const response = await GET(callbackRequest());
    expect(response.status).toBe(502);
    expect(called).toHaveLength(1);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects nonce mismatch without owner registration or browser session", async () => {
    const called = stubExchange(
      signedIdToken({ claims: { nonce: "other-sign-in" } }),
    );
    const response = await GET(callbackRequest());
    expect(response.status).toBe(502);
    expect(called).toHaveLength(1);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("creates a session only after signed ID-token and API validation", async () => {
    const called = stubExchange(signedIdToken());
    const response = await GET(callbackRequest());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://satns.vercel.app/join?connected=1",
    );
    expect(called).toEqual([
      `${issuer}token`,
      jwksUrl,
      "https://api.example.test/v1/owners/me",
    ]);
    expect(response.cookies.get(SESSION_COOKIE)?.httpOnly).toBe(true);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
