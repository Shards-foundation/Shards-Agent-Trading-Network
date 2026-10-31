import assert from "node:assert/strict";
import { test } from "node:test";
import { SATNS_NEON_TARGET, validateNeonReleaseConfig } from "./neon-release-preflight.mjs";

const sha = "a".repeat(40);
const valid = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  SATNS_EXPECTED_SHA: sha,
  SATNS_TARGET_PROJECT_ID: SATNS_NEON_TARGET.projectId,
  SATNS_TARGET_BRANCH_ID: SATNS_NEON_TARGET.branchId,
  SATNS_TARGET_DATABASE: "neondb",
  SATNS_DB_ACTION: "plan",
  EXECUTION_MODE: "PAPER",
  LIVE_EXECUTION_ENABLED: "false",
  DATABASE_URL:
    "postgresql://fictional:synthetic@ep-curly-paper-zaiknl2i.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require",
};

test("synthetic, pinned, manually dispatched plan passes static preflight", () => {
  assert.deepEqual(validateNeonReleaseConfig(valid), { ok: true, issues: [] });
});

test("production apply demands explicit approval and backup evidence", () => {
  const result = validateNeonReleaseConfig({ ...valid, SATNS_DB_ACTION: "apply" });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("EXPLICIT_APPLY_CONFIRMATION_REQUIRED"));
  assert.ok(result.issues.includes("BACKUP_REVIEW_REQUIRED"));
  assert.equal(
    validateNeonReleaseConfig({
      ...valid,
      SATNS_DB_ACTION: "apply",
      SATNS_DB_CONFIRMATION: "APPLY SATNS PRODUCTION SCHEMA",
      SATNS_BACKUP_REVIEW: "BACKUP_REVIEWED",
    }).ok,
    true,
  );
});

test("rejects accidental preview database or pooled database endpoint", () => {
  const result = validateNeonReleaseConfig({
    ...valid,
    DATABASE_URL:
      "postgresql://fictional:synthetic@ep-square-bonus-zaf931d1.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("WRONG_NEON_ENDPOINT"));
});

test("rejects wrong branch, wrong SHA, non-TLS and any live trading", () => {
  const result = validateNeonReleaseConfig({
    ...valid,
    SATNS_TARGET_BRANCH_ID: "br-invalid",
    SATNS_EXPECTED_SHA: "b".repeat(40),
    EXECUTION_MODE: "LIVE_RESTRICTED",
    LIVE_EXECUTION_ENABLED: "true",
    DATABASE_URL:
      "postgresql://fictional:synthetic@ep-curly-paper-zaiknl2i.c-2.eu-west-2.aws.neon.tech/neondb",
  });
  for (const code of [
    "NEON_BRANCH_MISMATCH",
    "GITHUB_SHA_MISMATCH",
    "PAPER_MODE_REQUIRED",
    "LIVE_TRADING_FORBIDDEN",
    "TLS_REQUIRED",
  ]) {
    assert.ok(result.issues.includes(code), code);
  }
});

test("rejects automated pushes and absent/malformed database credentials", () => {
  const result = validateNeonReleaseConfig({
    ...valid,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/feature",
    DATABASE_URL: "postgresql://fictional@localhost/neondb",
  });
  assert.ok(result.issues.includes("MANUAL_DISPATCH_REQUIRED"));
  assert.ok(result.issues.includes("MAIN_BRANCH_REQUIRED"));
  assert.ok(result.issues.includes("WRONG_NEON_ENDPOINT"));
  assert.ok(result.issues.includes("NEON_PASSWORD_MISSING"));
});

test("errors contain only fixed codes and never reveal credentials", () => {
  const result = validateNeonReleaseConfig({
    ...valid,
    DATABASE_URL:
      "postgresql://fictional:SECRET_NEVER_PRINT@wrong-host.example/neondb?sslmode=require",
  });
  const summary = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.ok(!summary.includes("SECRET_NEVER_PRINT"));
  assert.ok(!summary.includes("fictional"));
  assert.ok(!summary.includes("wrong-host"));
});
