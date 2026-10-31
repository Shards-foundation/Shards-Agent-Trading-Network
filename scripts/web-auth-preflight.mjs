import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function publicHttps(value) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !u.hostname ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.hostname.endsWith(".local") ||
      u.hostname.endsWith(".internal")
    )
      return null;
    return u;
  } catch {
    return null;
  }
}

export function validateWebAuthConfig(
  env,
  publicOrigin = "https://satns.vercel.app",
) {
  const issues = [];
  const check = (code, condition) => {
    if (!condition) issues.push(code);
  };

  const declaredOrigin = publicHttps(env.AUTH_PUBLIC_ORIGIN);
  check("WEB_PUBLIC_ORIGIN_INVALID", Boolean(declaredOrigin));
  check(
    "WEB_PUBLIC_ORIGIN_MISMATCH",
    Boolean(declaredOrigin) &&
      declaredOrigin.origin === publicOrigin &&
      declaredOrigin.pathname === "/",
  );

  const auth = publicHttps(env.OIDC_AUTHORIZATION_ENDPOINT);
  const token = publicHttps(env.OIDC_TOKEN_ENDPOINT);
  check("OIDC_AUTHORIZE_URL_INVALID", Boolean(auth));
  check("OIDC_TOKEN_URL_INVALID", Boolean(token));
  check(
    "OIDC_CLIENT_ID_MISSING",
    typeof env.OIDC_CLIENT_ID === "string" &&
      env.OIDC_CLIENT_ID.trim().length > 0,
  );
  check(
    "OIDC_API_AUDIENCE_MISSING",
    typeof env.OIDC_API_AUDIENCE === "string" &&
      env.OIDC_API_AUDIENCE.trim().length > 0,
  );
  check(
    "OIDC_ALGORITHM_INVALID",
    env.OIDC_JWT_ALGORITHM === undefined ||
      ["RS256", "EdDSA"].includes(env.OIDC_JWT_ALGORITHM),
  );
  check(
    "OIDC_RESOURCE_AUDIENCE_MISMATCH",
    !env.OIDC_RESOURCE || env.OIDC_RESOURCE === env.OIDC_API_AUDIENCE,
  );

  let secretLength = -1;
  try {
    const encoded = env.SATN_SESSION_KEY ?? "";
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") === encoded)
      secretLength = decoded.length;
  } catch {
    secretLength = -1;
  }
  check("SESSION_KEY_INVALID", secretLength === 32);

  const api = publicHttps(
    env.SATN_API_INTERNAL_URL ?? env.NEXT_PUBLIC_SATN_API_URL,
  );
  check("WEB_API_URL_INVALID", Boolean(api));
  check(
    "WEB_API_ORIGIN_MUST_DIFFER",
    Boolean(api) && (!declaredOrigin || api.origin !== declaredOrigin.origin),
  );
  // The existing trading terminal and agent profiles use this public variable.
  check(
    "LEGACY_TERMINAL_API_URL_INVALID",
    Boolean(publicHttps(env.NEXT_PUBLIC_SATN_API_URL)),
  );
  check("BOOTSTRAP_TOKEN_FORBIDDEN", !env.AGENT_REGISTRATION_TOKEN);
  check(
    "LIVE_TRADING_MUST_BE_DISABLED",
    env.LIVE_EXECUTION_ENABLED === "false",
  );

  // Never print supplied values, full URLs, JWTs, secrets or database strings.
  return { ok: issues.length === 0, issues };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const result = validateWebAuthConfig(process.env);
  console.info(
    JSON.stringify({
      event: "satns.web_auth.configuration_preflight",
      status: result.ok ? "PASS" : "BLOCKED",
      issues: result.issues,
      runtimeAuthenticationVerified: false,
      apiConnectivityVerified: false,
      liveTradingEnabled: false,
    }),
  );
  if (!result.ok) process.exitCode = 1;
}
