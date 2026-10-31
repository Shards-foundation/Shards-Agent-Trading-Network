import assert from "node:assert/strict";
import { test } from "node:test";
import { auditPublicPrelaunch } from "./launch-public-audit.mjs";

const SHA = "a".repeat(40);
const required = [
  "validate",
  "staging-container",
  "Dependency vulnerability audit",
  "Git history secret scan",
];

function fakeFetch({
  protectedBranch = true,
  vercel = "success",
  omittedCheck,
  loginStatus = 503,
  loginRedirect = false,
  networkStatus = 503,
  networkCode = "NETWORK_API_NOT_CONFIGURED",
  failPath,
} = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes(failPath || "@@no-such-path@@"))
      throw new Error("credentials-secret-must-never-leak");
    let status = 200;
    let body = {};
    const headers = new Headers();
    if (url.endsWith("/branches/main")) body = { protected: protectedBranch, commit: { sha: SHA } };
    else if (url.includes("/check-runs"))
      body = {
        check_runs: required.filter((n) => n !== omittedCheck).map((name) => ({
          name,
          status: "completed",
          conclusion: "success",
        })),
      };
    else if (url.endsWith("/status")) body = { statuses: [{ context: "Vercel", state: vercel }] };
    else if (url.endsWith("/api/auth/login")) {
      status = loginStatus;
      if (loginRedirect) headers.set("location", "https://idp.example.test/");
    } else if (url.endsWith("/api/network/stats")) {
      status = networkStatus;
      body = { error: { code: networkCode } };
    }
    return { status, headers, json: async () => body };
  };
  return { fetcher, calls };
}

test("synthetic locked prelaunch passes but NEVER certifies a production release", async () => {
  const { fetcher } = fakeFetch();
  const r = await auditPublicPrelaunch({ fetcher });
  assert.equal(r.status, "PRELAUNCH_CONTROLS_PASS");
  assert.deepEqual(r.issues, []);
  for (const field of [
    "productionCommitAttested",
    "neonRestoreVerified",
    "apiWorkerOidcIntegrationVerified",
    "productionLaunchApproved",
    "executionModeCertified",
  ]) {
    assert.equal(r[field], false);
  }
  assert.equal(r.mainSha, SHA);
});

test("unprotected main fails even with green CI and Vercel status", async () => {
  const r = await auditPublicPrelaunch({ fetcher: fakeFetch({ protectedBranch: false }).fetcher });
  assert.deepEqual(r.issues, ["MAIN_BRANCH_UNPROTECTED"]);
});

test("Vercel 402 quota signalled through failure status blocks release", async () => {
  const r = await auditPublicPrelaunch({ fetcher: fakeFetch({ vercel: "failure" }).fetcher });
  assert.ok(r.issues.includes("VERCEL_COMMIT_STATUS_NOT_GREEN"));
});

test("missing required CI job blocks release", async () => {
  const r = await auditPublicPrelaunch({ fetcher: fakeFetch({ omittedCheck: "validate" }).fetcher });
  assert.ok(r.issues.includes("MAIN_REQUIRED_CI_NOT_GREEN"));
});

test("OAuth redirect or 200 login fails the closed safety test", async () => {
  for (const options of [
    { loginStatus: 302, loginRedirect: true },
    { loginRedirect: true },
    { loginStatus: 200 },
  ]) {
    const r = await auditPublicPrelaunch({ fetcher: fakeFetch(options).fetcher });
    assert.ok(r.issues.includes("PUBLIC_LOGIN_NOT_FAIL_CLOSED"));
  }
});

test("network status is only accepted as 503 with explicit not-configured code", async () => {
  for (const options of [{ networkStatus: 200 }, { networkCode: "WRONG_ERROR" }]) {
    const r = await auditPublicPrelaunch({ fetcher: fakeFetch(options).fetcher });
    assert.ok(r.issues.includes("PUBLIC_NETWORK_NOT_FAIL_CLOSED"));
  }
});

test("upstream failures cannot pass or reveal provider errors or tokens", async () => {
  const { fetcher, calls } = fakeFetch({ failPath: "/branches/main" });
  const secret = "synthetic-secret-never-print";
  const r = await auditPublicPrelaunch({ fetcher, githubToken: secret });
  assert.ok(r.issues.includes("GITHUB_BRANCH_UNVERIFIED"));
  assert.equal(r.status, "BLOCKED");
  assert.equal(JSON.stringify(r).includes(secret), false);
  const siteRequests = calls.filter((c) => c.url.startsWith("https://satns.vercel.app"));
  assert.ok(siteRequests.length > 0);
  assert.ok(siteRequests.every((c) => !c.init.headers.Authorization));
});
