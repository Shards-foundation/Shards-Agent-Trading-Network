import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Offline, side-effect-free staging preflight. It validates only configuration.
// It does not verify live connectivity, backups, operator approvals or deployment.
function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isPrivateOrLoopbackHost(value) {
  try {
    const url = new URL(value);
    return (
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal")
    );
  } catch {
    return true;
  }
}

function databaseTransport(value) {
  try {
    const url = new URL(value);
    return (
      ["postgresql:", "postgres:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      ["require", "verify-ca", "verify-full"].includes(
        url.searchParams.get("sslmode"),
      )
    );
  } catch {
    return false;
  }
}

function redisTransport(value) {
  try {
    const url = new URL(value);
    return url.protocol === "rediss:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

export function validateStagingConfig(env) {
  const issues = [];
  const reject = (code, valid) => {
    if (!valid) issues.push(code);
  };
  reject("NODE_ENV_NOT_PRODUCTION", env.NODE_ENV === "production");
  reject("PAPER_MODE_REQUIRED", env.EXECUTION_MODE === "PAPER");
  reject("LIVE_TRADING_MUST_BE_DISABLED", env.LIVE_EXECUTION_ENABLED === "false");
  reject("API_BIND_ADDRESS_INVALID", env.API_HOST === "0.0.0.0");
  const port = positiveInteger(env.API_PORT);
  reject("API_PORT_INVALID", port !== null && port <= 65535);
  reject(
    "WEB_ORIGIN_MUST_USE_PUBLIC_HTTPS",
    httpsUrl(env.WEB_ORIGIN) && !isPrivateOrLoopbackHost(env.WEB_ORIGIN),
  );
  reject(
    "PUBLIC_API_URL_MUST_USE_HTTPS",
    httpsUrl(env.NEXT_PUBLIC_SATN_API_URL) &&
      !isPrivateOrLoopbackHost(env.NEXT_PUBLIC_SATN_API_URL),
  );
  reject("DATABASE_TLS_REQUIRED", databaseTransport(env.DATABASE_URL));
  reject("REDIS_TLS_REQUIRED", redisTransport(env.REDIS_URL));
  reject(
    "OIDC_ISSUER_HTTPS_REQUIRED",
    httpsUrl(env.OIDC_ISSUER) && !isPrivateOrLoopbackHost(env.OIDC_ISSUER),
  );
  reject(
    "OIDC_JWKS_HTTPS_REQUIRED",
    httpsUrl(env.OIDC_JWKS_URL) && !isPrivateOrLoopbackHost(env.OIDC_JWKS_URL),
  );
  reject(
    "OIDC_AUDIENCE_REQUIRED",
    typeof env.OIDC_AUDIENCE === "string" &&
      env.OIDC_AUDIENCE.trim().length > 0,
  );
  reject(
    "SHARED_BOOTSTRAP_TOKEN_FORBIDDEN",
    !env.AGENT_REGISTRATION_TOKEN,
  );
  reject(
    "WORKER_QUEUE_REQUIRED",
    typeof env.WORKER_QUEUE === "string" &&
      env.WORKER_QUEUE.trim().length > 0 &&
      env.WORKER_QUEUE.length <= 100,
  );
  const heartbeat = positiveInteger(env.WORKER_HEARTBEAT_MS);
  const stale = positiveInteger(env.WORKER_STALE_AFTER_MS);
  const lease = positiveInteger(env.WORKER_LEASE_MS);
  const grace = positiveInteger(env.WORKER_SHUTDOWN_GRACE_MS);
  reject(
    "WORKER_HEARTBEAT_TIMING_INVALID",
    heartbeat !== null && stale !== null && heartbeat < stale,
  );
  reject(
    "WORKER_SHUTDOWN_TIMING_INVALID",
    grace !== null && lease !== null && 2 * grace < lease,
  );

  // Only fixed error codes; never echo secrets, database URLs or JWT config.
  return { ok: issues.length === 0, issues };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const outcome = validateStagingConfig(process.env);
  console.info(
    JSON.stringify({
      event: "staging.configuration.preflight",
      status: outcome.ok ? "PASS" : "BLOCKED",
      issues: outcome.issues,
      operationalVerification: "NOT_PERFORMED",
      liveTradingEnabled: false,
    }),
  );
  if (!outcome.ok) process.exitCode = 1;
}
