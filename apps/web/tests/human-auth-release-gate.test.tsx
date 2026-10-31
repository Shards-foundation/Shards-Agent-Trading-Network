import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JoinPage from "../app/join/page";
import { GET as startLogin } from "../app/api/auth/login/route";
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from "../app/lib/auth-session";
import { humanAuthReady } from "../app/lib/human-auth-ready";

const origin = "https://satns.vercel.app";
const validEnv = {
  SATNS_HUMAN_AUTH_ENABLED: "true",
  OIDC_CLIENT_ID: "test-browser-client",
  OIDC_AUTHORIZATION_ENDPOINT: "https://id.example.test/authorize",
  OIDC_TOKEN_ENDPOINT: "https://id.example.test/token",
  OIDC_ISSUER: "https://id.example.test/",
  OIDC_JWKS_URL: "https://id.example.test/jwks",
  OIDC_ID_TOKEN_ALGORITHM: "RS256",
  AUTH_PUBLIC_ORIGIN: origin,
  SATN_SESSION_KEY: Buffer.alloc(32, 6).toString("base64url"),
  SATN_API_INTERNAL_URL: "https://api.example.test",
};

beforeEach(() => {
  for (const [key, value] of Object.entries(validEnv)) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("human OIDC signup release gate", () => {
  it("blocks signup by default even with valid OIDC credentials", async () => {
    vi.stubEnv("SATNS_HUMAN_AUTH_ENABLED", "");
    expect(humanAuthReady()).toBe(false);
    const html = renderToStaticMarkup(JoinPage());
    expect(html).toContain("Registration not yet open");
    expect(html).not.toContain('href="/api/auth/login?intent=signup"');
    const reply = await startLogin(
      new NextRequest(`${origin}/api/auth/login?intent=signup`),
    );
    expect(reply.status).toBe(503);
    expect(reply.headers.get("location")).toBeNull();
    expect(reply.headers.get("set-cookie")).toBeNull();
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["issuer missing", "OIDC_ISSUER", ""],
    ["jwks missing", "OIDC_JWKS_URL", ""],
    ["jwks downgrade", "OIDC_JWKS_URL", "http://id.example.test/jwks"],
    ["unsupported signature", "OIDC_ID_TOKEN_ALGORITHM", "none"],
    ["bad secret key", "SATN_SESSION_KEY", "not-32-bytes"],
    ["missing API", "SATN_API_INTERNAL_URL", ""],
    ["unsafe API", "SATN_API_INTERNAL_URL", "http://api.example.test/"],
    ["self-referential API", "SATN_API_INTERNAL_URL", origin],
    ["API URL with path", "SATN_API_INTERNAL_URL", "https://api.example.test/v1"],
  ])("blocks %s before redirect", async (_reason, variable, value) => {
    vi.stubEnv(variable, value);
    if (variable === "SATN_API_INTERNAL_URL" && value === "") {
      vi.stubEnv("NEXT_PUBLIC_SATN_API_URL", "");
    }
    expect(humanAuthReady()).toBe(false);
    const reply = await startLogin(new NextRequest(`${origin}/api/auth/login`));
    expect(reply.status).toBe(503);
    expect(reply.headers.get("location")).toBeNull();
    expect(reply.headers.get("set-cookie")).toBeNull();
  });

  it("issues an S256 PKCE challenge and nonce only after operator opt-in", async () => {
    expect(humanAuthReady()).toBe(true);
    const html = renderToStaticMarkup(JoinPage());
    expect(html).toContain('href="/api/auth/login?intent=signup"');
    const reply = await startLogin(
      new NextRequest(`${origin}/api/auth/login?intent=signup`),
    );
    expect(reply.status).toBe(307);
    const location = new URL(reply.headers.get("location")!);
    expect(location.origin).toBe("https://id.example.test");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("test-browser-client");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("screen_hint")).toBe("signup");
    const verifier = reply.cookies.get(OAUTH_VERIFIER_COOKIE)?.value;
    const nonce = reply.cookies.get(OAUTH_NONCE_COOKIE)?.value;
    const state = reply.cookies.get(OAUTH_STATE_COOKIE)?.value;
    expect(verifier).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(state).toBeTruthy();
    expect(nonce).not.toBe(state);
    expect(location.searchParams.get("nonce")).toBe(nonce);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier!).digest("base64url"),
    );
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });
});
