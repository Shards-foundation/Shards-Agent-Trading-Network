import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SATNS_NEON_TARGET = Object.freeze({
  projectId: "rough-mud-39112486",
  branchId: "br-dawn-cloud-za1h61qf",
  database: "neondb",
  hostname: "ep-curly-paper-zaiknl2i.c-2.eu-west-2.aws.neon.tech",
});

const confirmationPhrase = "APPLY SATNS PRODUCTION SCHEMA";

export function validateNeonReleaseConfig(env) {
  const issues = [];
  const check = (code, valid) => {
    if (!valid) issues.push(code);
  };

  check("MANUAL_DISPATCH_REQUIRED", env.GITHUB_EVENT_NAME === "workflow_dispatch");
  check("MAIN_BRANCH_REQUIRED", env.GITHUB_REF === "refs/heads/main");
  check("NEON_PROJECT_MISMATCH", env.SATNS_TARGET_PROJECT_ID === SATNS_NEON_TARGET.projectId);
  check("NEON_BRANCH_MISMATCH", env.SATNS_TARGET_BRANCH_ID === SATNS_NEON_TARGET.branchId);
  check("DATABASE_NAME_MISMATCH", env.SATNS_TARGET_DATABASE === SATNS_NEON_TARGET.database);
  check("PAPER_MODE_REQUIRED", env.EXECUTION_MODE === "PAPER");
  check("LIVE_TRADING_FORBIDDEN", env.LIVE_EXECUTION_ENABLED === "false");
  check("RELEASE_ACTION_INVALID", ["plan", "apply"].includes(env.SATNS_DB_ACTION));

  const expectedSha = env.SATNS_EXPECTED_SHA ?? "";
  check("EXPECTED_SHA_INVALID", /^[a-f0-9]{40}$/.test(expectedSha));
  check("GITHUB_SHA_MISMATCH", expectedSha === env.GITHUB_SHA);

  const raw = env.DATABASE_URL ?? "";
  let database;
  try {
    database = new URL(raw);
  } catch {
    database = null;
  }

  check("DATABASE_URL_INVALID", Boolean(database));
  if (database) {
    check("POSTGRES_SCHEME_REQUIRED", ["postgresql:", "postgres:"].includes(database.protocol));
    check("WRONG_NEON_ENDPOINT", database.hostname === SATNS_NEON_TARGET.hostname);
    check("UNPOOLED_ENDPOINT_REQUIRED", !database.hostname.includes("-pooler"));
    check("NEON_DB_NAME_MISMATCH", database.pathname === "/neondb");
    check("NEON_ROLE_MISSING", Boolean(database.username));
    check("NEON_PASSWORD_MISSING", Boolean(database.password));
    check("TLS_REQUIRED", ["require", "verify-full"].includes(database.searchParams.get("sslmode")));
    check("DATABASE_URL_HAS_FRAGMENT", !database.hash);
  }
  if (env.SATNS_DB_ACTION === "apply") {
    check("EXPLICIT_APPLY_CONFIRMATION_REQUIRED", env.SATNS_DB_CONFIRMATION === confirmationPhrase);
    check("BACKUP_REVIEW_REQUIRED", env.SATNS_BACKUP_REVIEW === "BACKUP_REVIEWED");
  }

  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = validateNeonReleaseConfig(process.env);
  // Emit only fixed error codes. Never log database URLs, usernames or credentials.
  console.info(
    JSON.stringify({
      event: "satns.neon.production_release_preflight",
      status: result.ok ? "PASS" : "HALTED",
      action: ["plan", "apply"].includes(process.env.SATNS_DB_ACTION)
        ? process.env.SATNS_DB_ACTION
        : "invalid",
      issues: result.issues,
      liveExecutionEnabled: false,
    }),
  );
  if (!result.ok) process.exitCode = 1;
}
