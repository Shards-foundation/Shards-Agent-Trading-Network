import assert from "node:assert/strict";
import { test } from "node:test";
import { validateStagingConfig } from "./staging-preflight.mjs";

// Synthetic, non-operational URLs. Passing this test cannot approve staging.
const valid = {
  NODE_ENV: "production",
  EXECUTION_MODE: "PAPER",
  LIVE_EXECUTION_ENABLED: "false",
  API_HOST: "0.0.0.0",
  API_PORT: "4000",
  WEB_ORIGIN: "https://web.example.com",
  NEXT_PUBLIC_SATN_API_URL: "https://api.example.com",
  DATABASE_URL: "postgresql://fake:example@db.example.com/satn?sslmode=require",
  REDIS_URL: "rediss://fake:example@cache.example.com:6380",
  OIDC_ISSUER: "https://id.example.com/",
  OIDC_JWKS_URL: "https://id.example.com/.well-known/jwks.json",
  OIDC_AUDIENCE: "satn-api",
  WORKER_QUEUE: "default",
  WORKER_HEARTBEAT_MS: "5000",
  WORKER_STALE_AFTER_MS: "30000",
  WORKER_LEASE_MS: "30000",
  WORKER_SHUTDOWN_GRACE_MS: "10000",
};

test("valid synthetic staging configuration passes syntax checks only", () => {
  assert.deepEqual(validateStagingConfig(valid), { ok: true, issues: [] });
});

test("live mode, public bootstrap tokens and non-production contexts fail closed", () => {
  const result = validateStagingConfig({
    ...valid,
    EXECUTION_MODE: "LIVE_RESTRICTED",
    LIVE_EXECUTION_ENABLED: "true",
    NODE_ENV: "development",
    AGENT_REGISTRATION_TOKEN: "never-print-this-secret",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, [
    "NODE_ENV_NOT_PRODUCTION",
    "PAPER_MODE_REQUIRED",
    "LIVE_TRADING_MUST_BE_DISABLED",
    "SHARED_BOOTSTRAP_TOKEN_FORBIDDEN",
  ]);
  assert.equal(JSON.stringify(result).includes("never-print-this-secret"), false);
});

test("rejects insecure transport, private browser origins and missing identity", () => {
  const result = validateStagingConfig({
    ...valid,
    DATABASE_URL: "postgresql://fake:never-print-this@db.example.com/satn",
    REDIS_URL: "redis://localhost:6379",
    WEB_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_SATN_API_URL: "http://127.0.0.1:4000",
    OIDC_ISSUER: "http://issuer.example.com",
    OIDC_JWKS_URL: "http://issuer.example.com/jwks",
    OIDC_AUDIENCE: "",
  });
  assert.equal(result.ok, false);
  for (const issue of [
    "WEB_ORIGIN_MUST_USE_PUBLIC_HTTPS",
    "PUBLIC_API_URL_MUST_USE_HTTPS",
    "DATABASE_TLS_REQUIRED",
    "REDIS_TLS_REQUIRED",
    "OIDC_ISSUER_HTTPS_REQUIRED",
    "OIDC_JWKS_HTTPS_REQUIRED",
    "OIDC_AUDIENCE_REQUIRED",
  ]) {
    assert.ok(result.issues.includes(issue), issue);
  }
  assert.equal(JSON.stringify(result).includes("never-print-this"), false);
});

test("rejects missing worker supervision timings or an invalid bind port", () => {
  const result = validateStagingConfig({
    ...valid,
    API_PORT: "99999",
    API_HOST: "127.0.0.1",
    WORKER_QUEUE: " ",
    WORKER_HEARTBEAT_MS: "30000",
    WORKER_STALE_AFTER_MS: "5000",
    WORKER_LEASE_MS: "5000",
    WORKER_SHUTDOWN_GRACE_MS: "3000",
  });
  assert.equal(result.ok, false);
  for (const issue of [
    "API_BIND_ADDRESS_INVALID",
    "API_PORT_INVALID",
    "WORKER_QUEUE_REQUIRED",
    "WORKER_HEARTBEAT_TIMING_INVALID",
    "WORKER_SHUTDOWN_TIMING_INVALID",
  ]) {
    assert.ok(result.issues.includes(issue), issue);
  }
});

test("rejects malformed and credential-bearing public origins", () => {
  const result = validateStagingConfig({
    ...valid,
    WEB_ORIGIN: "https://admin:password@web.example.com",
    NEXT_PUBLIC_SATN_API_URL: "malformed",
    DATABASE_URL: "postgresql://example.invalid/satn?sslmode=disable",
    REDIS_URL: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.includes("WEB_ORIGIN_MUST_USE_PUBLIC_HTTPS"), true);
  assert.equal(result.issues.includes("PUBLIC_API_URL_MUST_USE_HTTPS"), true);
  assert.equal(result.issues.includes("DATABASE_TLS_REQUIRED"), true);
  assert.equal(result.issues.includes("REDIS_TLS_REQUIRED"), true);
});
