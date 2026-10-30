import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { clearOidcJwksCacheForTests, verifyOidcAccessToken, type OidcConfig } from "../src/index.js";

const issuer = "https://identity.example.test/";
const audience = "satn-api";
const jwksUrl = "https://identity.example.test/.well-known/jwks.json";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "satn-test-key", alg: "RS256", use: "sig" };
const config: OidcConfig = { issuer, audience, jwksUrl };

function token(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
  const header = { alg: "RS256", typ: "JWT", kid: "satn-test-key", ...headerOverrides };
  const payload = {
    iss: issuer,
    aud: audience,
    sub: "user-123",
    exp: 1_800_000_000,
    nbf: 1_700_000_000,
    ...overrides
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const content = `${encodedHeader}.${encodedPayload}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}

const fetcher = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
  status: 200,
  headers: { "content-type": "application/json" }
});

afterEach(() => clearOidcJwksCacheForTests());

describe("OIDC JWT verification", () => {
  it("verifies RS256 signature and issuer/audience/expiry claims", async () => {
    const result = await verifyOidcAccessToken(token(), config, { fetcher, nowMs: 1_750_000_000_000 });
    expect(result).toMatchObject({
      issuer,
      subject: "user-123",
      audience: [audience],
      expiresAt: 1_800_000_000
    });
  });

  it("accepts an audience array containing the configured audience", async () => {
    const result = await verifyOidcAccessToken(token({ aud: ["another-client", audience] }), config, { fetcher, nowMs: 1_750_000_000_000 });
    expect(result.subject).toBe("user-123");
  });

  it("rejects issuer, audience, expired and not-yet-valid tokens", async () => {
    await expect(verifyOidcAccessToken(token({ iss: "https://evil.example/" }), config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("issuer");
    await expect(verifyOidcAccessToken(token({ aud: "wrong-audience" }), config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("audience");
    await expect(verifyOidcAccessToken(token({ exp: 1_700_000_000 }), config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("expired");
    await expect(verifyOidcAccessToken(token({ nbf: 1_800_000_000 }), config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("not yet valid");
  });

  it("rejects unsigned or non-RS256 JWTs", async () => {
    await expect(verifyOidcAccessToken(token({}, { alg: "none" }), config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("RS256");
    await expect(verifyOidcAccessToken("not.a.jwt", config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("Malformed JWT");
  });

  it("rejects a signature that does not match the selected key", async () => {
    const invalid = token();
    const parts = invalid.split(".");
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: "attacker", exp: 1_800_000_000 })).toString("base64url")}.${parts[2]}`;
    await expect(verifyOidcAccessToken(tampered, config, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("signature");
  });

  it("requires HTTPS for remote JWKS endpoints", async () => {
    await expect(verifyOidcAccessToken(token(), { ...config, jwksUrl: "http://identity.example.test/jwks" }, { fetcher, nowMs: 1_750_000_000_000 })).rejects.toThrow("HTTPS");
  });

  it("fails closed on unusable JWKS responses", async () => {
    await expect(verifyOidcAccessToken(token(), config, {
      fetcher: async () => new Response("nope", { status: 503 }),
      nowMs: 1_750_000_000_000
    })).rejects.toThrow("non-success");
  });
});
