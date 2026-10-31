import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWebAuthConfig } from "./web-auth-preflight.mjs";

const valid = {
  AUTH_PUBLIC_ORIGIN: "https://satns.vercel.app",
  OIDC_CLIENT_ID: "synthetic-browser-client",
  OIDC_API_AUDIENCE: "satn-api",
  OIDC_AUTHORIZATION_ENDPOINT: "https://id.example.com/authorize",
  OIDC_TOKEN_ENDPOINT: "https://id.example.com/oauth/token",
  SATN_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  SATN_API_INTERNAL_URL: "https://api.example.com",
  NEXT_PUBLIC_SATN_API_URL: "https://api.example.com",
  LIVE_EXECUTION_ENABLED: "false",
};

test("valid synthetic settings pass syntax checks, not authentication verification", () => {
  assert.deepEqual(validateWebAuthConfig(valid), { ok: true, issues: [] });
});

test("wrong domain, invalid session key, and unsafe identity URL fail closed", () => {
  const result = validateWebAuthConfig({
    ...valid,
    AUTH_PUBLIC_ORIGIN: "https://example.com",
    SATN_SESSION_KEY: "not-a-valid-session-key",
    OIDC_AUTHORIZATION_ENDPOINT: "http://localhost/authorize",
    OIDC_API_AUDIENCE: "",
  });
  assert.equal(result.ok, false);
  for (const name of [
    "WEB_PUBLIC_ORIGIN_MISMATCH",
    "SESSION_KEY_INVALID",
    "OIDC_AUTHORIZE_URL_INVALID",
    "OIDC_API_AUDIENCE_MISSING",
  ])
    assert.ok(result.issues.includes(name), name);
});

test("never proxies the API to the public website itself", () => {
  const result = validateWebAuthConfig({
    ...valid,
    SATN_API_INTERNAL_URL: "https://satns.vercel.app",
  });
  assert.ok(result.issues.includes("WEB_API_ORIGIN_MUST_DIFFER"));
});

test("rejects disabled transport, bootstrap credential and live trading", () => {
  const result = validateWebAuthConfig({
    ...valid,
    NEXT_PUBLIC_SATN_API_URL: "http://127.0.0.1:4000",
    AGENT_REGISTRATION_TOKEN: "never-print-me",
    LIVE_EXECUTION_ENABLED: "true",
    OIDC_TOKEN_ENDPOINT: "https://user:password@id.example.com/token",
  });
  assert.equal(result.ok, false);
  for (const name of [
    "LEGACY_TERMINAL_API_URL_INVALID",
    "BOOTSTRAP_TOKEN_FORBIDDEN",
    "LIVE_TRADING_MUST_BE_DISABLED",
    "OIDC_TOKEN_URL_INVALID",
  ])
    assert.ok(result.issues.includes(name), name);
  assert.ok(!JSON.stringify(result).includes("never-print-me"));
  assert.ok(!JSON.stringify(result).includes("password"));
});

test("rejects a provider signing algorithm downgrade or mismatched OAuth resource", () => {
  const result = validateWebAuthConfig({
    ...valid,
    OIDC_JWT_ALGORITHM: "none",
    OIDC_RESOURCE: "another-api",
  });
  assert.ok(result.issues.includes("OIDC_ALGORITHM_INVALID"));
  assert.ok(result.issues.includes("OIDC_RESOURCE_AUDIENCE_MISMATCH"));

  const neonSafe = validateWebAuthConfig({
    ...valid,
    OIDC_JWT_ALGORITHM: "EdDSA",
    OIDC_RESOURCE: valid.OIDC_API_AUDIENCE,
  });
  assert.equal(neonSafe.ok, true);
});

test("requires explicit provider and API configuration", () => {
  const result = validateWebAuthConfig({});
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("OIDC_CLIENT_ID_MISSING"));
  assert.ok(result.issues.includes("WEB_API_URL_INVALID"));
  assert.ok(result.issues.includes("SESSION_KEY_INVALID"));
});
