import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Read-only public release audit. Passing never certifies a production launch.
const REPO = "Shards-foundation/Shards-Agent-Trading-Network";
const ORIGIN = "https://satns.vercel.app";
const REQUIRED_CHECKS = [
  "validate",
  "staging-container",
  "Dependency vulnerability audit",
  "Git history secret scan",
];

async function request(fetcher, url, token) {
  const api = url.startsWith("https://api.github.com/");
  const headers = api
    ? {
        Accept: "application/vnd.github+json",
        "User-Agent": "satns-readonly-launch-audit",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
    : { Accept: "application/json,text/html" };
  return fetcher(url, {
    method: "GET",
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(10000),
  });
}

async function jsonGet(fetcher, url, token) {
  const response = await request(fetcher, url, token);
  if (response.status !== 200) throw new Error("UPSTREAM_UNAVAILABLE");
  return response.json();
}

function unique(items) {
  return [...new Set(items)];
}

export async function auditPublicPrelaunch({
  fetcher = fetch,
  githubToken,
  repository = REPO,
  origin = ORIGIN,
} = {}) {
  const issues = [];
  const checks = {};
  const api = `https://api.github.com/repos/${repository}`;
  let sha = null;

  // The unprotected branch is a hard release gate, independent of CI success.
  try {
    const branch = await jsonGet(fetcher, `${api}/branches/main`, githubToken);
    sha = typeof branch?.commit?.sha === "string" && /^[a-f\d]{40}$/.test(branch.commit.sha)
      ? branch.commit.sha
      : null;
    checks.mainProtected = branch?.protected === true;
    if (!checks.mainProtected) issues.push("MAIN_BRANCH_UNPROTECTED");
    if (!sha) issues.push("MAIN_SHA_UNVERIFIED");
  } catch {
    issues.push("GITHUB_BRANCH_UNVERIFIED");
  }

  if (sha) {
    try {
      const result = await jsonGet(fetcher, `${api}/commits/${sha}/check-runs?per_page=100`, githubToken);
      const runs = Array.isArray(result?.check_runs) ? result.check_runs : [];
      checks.requiredCi = REQUIRED_CHECKS.every((name) =>
        runs.some((run) => run.name === name && run.status === "completed" && run.conclusion === "success"),
      );
      if (!checks.requiredCi) issues.push("MAIN_REQUIRED_CI_NOT_GREEN");
    } catch {
      issues.push("MAIN_CI_UNVERIFIED");
    }
    try {
      const result = await jsonGet(fetcher, `${api}/commits/${sha}/status`, githubToken);
      const statuses = Array.isArray(result?.statuses) ? result.statuses : [];
      checks.vercelCommitStatus = statuses.some(
        (status) => status.context === "Vercel" && status.state === "success",
      );
      if (!checks.vercelCommitStatus) issues.push("VERCEL_COMMIT_STATUS_NOT_GREEN");
    } catch {
      issues.push("VERCEL_COMMIT_STATUS_UNVERIFIED");
    }
  }

  for (const [path, checkName, expectedCode, problem] of [
    ["/", "home", 200, "PUBLIC_HOME_UNAVAILABLE"],
    ["/join", "join", 200, "PUBLIC_JOIN_UNAVAILABLE"],
    ["/api/auth/login", "loginClosed", 503, "PUBLIC_LOGIN_NOT_FAIL_CLOSED"],
    ["/api/network/stats", "networkClosed", 503, "PUBLIC_NETWORK_NOT_FAIL_CLOSED"],
  ]) {
    try {
      const response = await request(fetcher, `${origin}${path}`);
      let ok = response.status === expectedCode;
      if (checkName === "loginClosed") {
        ok = ok && !response.headers.get("location") && !response.headers.get("set-cookie");
      }
      if (checkName === "networkClosed" && ok) {
        try {
          const body = await response.json();
          ok = body?.error?.code === "NETWORK_API_NOT_CONFIGURED";
        } catch {
          ok = false;
        }
      }
      checks[checkName] = ok;
      if (!ok) issues.push(problem);
    } catch {
      checks[checkName] = false;
      issues.push(problem);
    }
  }

  const issueCodes = unique(issues);
  return {
    event: "satns.public_prelaunch_audit",
    status: issueCodes.length === 0 ? "PRELAUNCH_CONTROLS_PASS" : "BLOCKED",
    checkedAt: new Date().toISOString(),
    mainSha: sha,
    checks,
    issues: issueCodes,
    // GitHub/Vercel HTTP probes cannot certify the exact deployed alias SHA.
    productionCommitAttested: false,
    neonRestoreVerified: false,
    apiWorkerOidcIntegrationVerified: false,
    productionLaunchApproved: false,
    executionModeCertified: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await auditPublicPrelaunch({ githubToken: process.env.GITHUB_TOKEN });
  // Fixed issue codes, booleans and commit ID only. Never emit credentials or provider payloads.
  console.info(JSON.stringify(result));
  if (result.issues.length) process.exitCode = 1;
}
