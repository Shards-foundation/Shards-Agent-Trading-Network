import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
import { buildServer } from "../apps/api/dist/index.js";
import { runBrowserSmoke } from "./browser-smoke.mjs";

// Runs real HTTP boundaries: Fastify -> PostgreSQL/Redis -> Next.js SSR.
// This is a server-rendered E2E test; it is NOT a browser JavaScript test.
// Only run against a disposable, migrated test database.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
assert.ok(process.env.REDIS_URL, "REDIS_URL is required");
assert.equal(process.env.EXECUTION_MODE, "PAPER");
assert.equal(process.env.LIVE_EXECUTION_ENABLED, "false");
assert.equal(process.env.NODE_ENV, "production");
assert.equal(
  process.env.OIDC_ISSUER,
  undefined,
  "CI uses an isolated bootstrap test owner",
);
assert.equal(process.env.OIDC_AUDIENCE, undefined);
assert.equal(process.env.OIDC_JWKS_URL, undefined);

const bootstrapToken = `e2e-only-${randomUUID()}`;
process.env.AGENT_REGISTRATION_TOKEN = bootstrapToken;

const prisma = new PrismaClient();
const api = buildServer();
const webRoot = resolve("apps/web");
const nextBin = resolve(webRoot, "node_modules/next/dist/bin/next");
let nextProcess;
let apiUrl;
let agentId;
let journalId;
let ownerId;
let networkPostId;
let legacyReplyId;

async function availablePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return address.port;
}

async function eventually(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (nextProcess && nextProcess.exitCode !== null) {
      throw new Error(
        `Next.js process exited early (${nextProcess.exitCode}) while waiting for ${label}`,
      );
    }
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

async function read(url) {
  return fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
    headers: { "cache-control": "no-store" },
  });
}

async function post(url, payload, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
}

async function stopNext() {
  if (
    !nextProcess ||
    nextProcess.exitCode !== null ||
    nextProcess.signalCode !== null
  ) {
    return;
  }
  const child = nextProcess;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

try {
  // Use the production default Redis-backed rate limiter. This ensures the
  // exercise cannot pass using the development in-memory limiter.
  apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  const webPort = await availablePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  nextProcess = spawn(
    process.execPath,
    [nextBin, "start", "-H", "127.0.0.1", "-p", String(webPort)],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        SATN_API_URL: apiUrl,
        NEXT_PUBLIC_SATN_API_URL: apiUrl,
        EXECUTION_MODE: "PAPER",
        LIVE_EXECUTION_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  nextProcess.stdout.resume();
  nextProcess.stderr.resume();

  const homepage = await eventually(async () => {
    const res = await read(webUrl);
    if (res.status !== 200) return null;
    const body = await res.text();
    return body.includes("AGENT TRADING NETWORK") &&
      body.includes("LIVE EXECUTION DISABLED") &&
      body.includes("ACTIVE SHARDS")
      ? body
      : null;
  }, "Next.js homepage");

  assert.ok(homepage.includes("PAPER-FIRST"));
  assert.ok(
    !homepage.includes(bootstrapToken),
    "bootstrap secret must not appear in HTML",
  );

  const terminal = await read(`${webUrl}/terminal`);
  assert.equal(terminal.status, 200);
  const terminalHtml = await terminal.text();
  assert.ok(terminalHtml.includes("LIVE ORDERS DISABLED"));
  assert.ok(terminalHtml.includes("Wallet control"));
  assert.ok(terminalHtml.includes("Activity"));
  assert.ok(terminalHtml.includes("No swap is submitted from this screen."));

  const wallets = await read(`${webUrl}/wallets`);
  assert.equal(wallets.status, 200);
  const walletHtml = await wallets.text();
  assert.ok(walletHtml.includes("Prove ownership"));
  assert.ok(walletHtml.includes("Sign in to verify"));
  assert.ok(walletHtml.includes("PAPER ONLY"));
  const unauthedWalletRegistry = await read(`${webUrl}/api/wallets/registered`);
  assert.equal(unauthedWalletRegistry.status, 401);

  // Execute real Chromium hydration and click tests against this disposable
  // production-build Next.js server; no production services or real credentials.
  await runBrowserSmoke(webUrl);

  const unauthorised = await post(`${apiUrl}/v1/agents`, {
    name: "Unauthorised",
  });
  assert.equal(unauthorised.status, 401);

  const name = `e2e-agent-${randomUUID().slice(0, 8)}`;
  const registration = await post(
    `${apiUrl}/v1/agents`,
    { name, description: "E2E evidence: simulated activity only" },
    { "x-registration-token": bootstrapToken },
  );
  assert.equal(registration.status, 201);
  const created = await registration.json();
  agentId = created.agent.id;
  assert.equal(created.agent.mode, "PAPER");
  const agentToken = created.credential.token;
  assert.ok(agentToken.startsWith("satn_agent_"));

  const persisted = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { ownerId: true },
  });
  assert.ok(persisted);
  ownerId = persisted.ownerId;

  const noAuth = await post(`${apiUrl}/v1/agents/${agentId}/journal`, {
    body: "blocked",
  });
  assert.equal(noAuth.status, 401);

  const privateEntry = await post(
    `${apiUrl}/v1/agents/${agentId}/journal`,
    { body: `PRIVATE-${randomUUID()}`, publish: false },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(privateEntry.status, 201);
  const privateBody = (await privateEntry.json()).journal.body;

  const publicMarker = `PUBLISHED-E2E-${randomUUID().slice(0, 8)}`;
  const journal = await post(
    `${apiUrl}/v1/agents/${agentId}/journal`,
    {
      body: `${publicMarker} <script>alert("injection")</script>`,
      publish: true,
    },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(journal.status, 201);
  const published = await journal.json();
  journalId = published.journal.id;
  assert.equal(published.journal.provenance, "SELF_REPORTED");

  // Exercise the new community feed against real migrated PostgreSQL.
  const networkStats = await read(`${apiUrl}/v1/network/stats`);
  assert.equal(networkStats.status, 200);
  assert.equal((await networkStats.json()).source, "postgres");

  const communities = await read(`${apiUrl}/v1/network/communities`);
  assert.equal(communities.status, 200);
  const communityPayload = await communities.json();
  assert.ok(communityPayload.items.some((item) => item.slug === "general"));

  const socialPost = await post(
    `${apiUrl}/v1/network/posts`,
    {
      communitySlug: "general",
      body: `E2E social research ${randomUUID()}`,
    },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(socialPost.status, 201);
  networkPostId = (await socialPost.json()).post.id;

  const socialFeed = await read(`${apiUrl}/v1/network/posts?community=general`);
  assert.equal(socialFeed.status, 200);
  const feedPayload = await socialFeed.json();
  assert.ok(feedPayload.items.some((item) => item.id === networkPostId));

  const vote = await post(
    `${apiUrl}/v1/network/posts/${networkPostId}/vote`,
    { value: 1 },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(vote.status, 200);
  assert.equal((await vote.json()).upvotes, 1);

  const comment = await post(
    `${apiUrl}/v1/network/posts/${networkPostId}/comments`,
    { body: "Paper-first evidence; not a live execution record." },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(comment.status, 201);
  const discussion = await read(
    `${apiUrl}/v1/network/posts/${networkPostId}/comments`,
  );
  assert.equal(discussion.status, 200);
  const discussionPayload = await discussion.json();
  assert.ok(
    discussionPayload.items.some((item) =>
      item.body.includes("Paper-first evidence"),
    ),
  );
  assert.ok(discussionPayload.items.every((item) => !("actorId" in item)));
  const identityRedaction = await post(
    `${apiUrl}/v1/network/posts/${networkPostId}/comments`,
    { body: "Validate private actor identity redaction." },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(identityRedaction.status, 201);
  assert.equal("actorId" in (await identityRedaction.json()).comment, false);

  // Moderation must never leak hidden legacy-reply counts through the new
  // social feed, even though the legacy AgentPost relation still exists.
  const legacyReply = await prisma.agentPost.create({
    data: {
      agentId,
      parentId: networkPostId,
      body: "Temporary public legacy reply for moderation regression.",
    },
  });
  legacyReplyId = legacyReply.id;
  const feedWithLegacyReply = await read(
    `${apiUrl}/v1/network/posts?community=general`,
  );
  assert.equal(feedWithLegacyReply.status, 200);
  assert.equal(
    (await feedWithLegacyReply.json()).items.find(
      (item) => item.id === networkPostId,
    )?.comments,
    3,
    "two network comments and one visible legacy reply must count",
  );
  await prisma.agentPost.update({
    where: { id: legacyReplyId },
    data: { hiddenAt: new Date() },
  });
  const feedAfterModeration = await read(
    `${apiUrl}/v1/network/posts?community=general`,
  );
  assert.equal(feedAfterModeration.status, 200);
  assert.equal(
    (await feedAfterModeration.json()).items.find(
      (item) => item.id === networkPostId,
    )?.comments,
    2,
    "hidden legacy reply must not be exposed in the social comment counter",
  );

  const profileUrl = `${webUrl}/agents/${agentId}`;
  const profile = await eventually(async () => {
    const res = await read(profileUrl);
    if (res.status !== 200) return null;
    const html = await res.text();
    return html.includes(publicMarker) ? html : null;
  }, "SSR agent profile displaying persisted public journal");
  assert.ok(profile.includes(name));
  assert.ok(
    profile.includes("SELF REPORTED") || profile.includes("SELF_REPORTED"),
  );
  assert.ok(
    !profile.includes(privateBody),
    "unpublished journal must stay private",
  );
  assert.ok(
    !profile.includes(agentToken),
    "agent token must not appear in HTML",
  );
  assert.ok(
    !profile.includes('<script>alert("injection")</script>'),
    "raw journal script must be escaped",
  );

  const data = await read(`${apiUrl}/v1/agents/${agentId}/journal?limit=10`);
  assert.equal(data.status, 200);
  const payload = await data.json();
  assert.equal(
    payload.items.some((item) => item.id === journalId),
    true,
  );
  assert.equal(
    payload.items.some((item) => item.body === privateBody),
    false,
  );

  const paused = await post(
    `${apiUrl}/v1/agents/${agentId}/pause`,
    {},
    { "x-registration-token": bootstrapToken },
  );
  assert.equal(paused.status, 200);
  const afterPause = await read(profileUrl);
  assert.equal(
    afterPause.status,
    404,
    "paused agents must be absent from public SSR",
  );
  const pausedComments = await read(
    `${apiUrl}/v1/network/posts/${networkPostId}/comments`,
  );
  assert.equal(
    pausedComments.status,
    404,
    "paused Shard comments must not be public",
  );

  const blockedWrite = await post(
    `${apiUrl}/v1/agents/${agentId}/journal`,
    { body: "paused write should fail" },
    { authorization: `Bearer ${agentToken}` },
  );
  assert.equal(blockedWrite.status, 401);

  const revoked = await prisma.agentCredential.findMany({
    where: { agentId },
    select: { secretHash: true },
  });
  assert.equal(revoked.length, 1);
  assert.notEqual(revoked[0].secretHash, agentToken);

  console.info(
    JSON.stringify({
      event: "e2e.fullstack.passed",
      scenarios: [
        "homepage-production-SSR",
        "legacy-terminal-preserved",
        "postgres-backed-network-stats",
        "seeded-community-discovery",
        "agent-social-post-persisted",
        "agent-vote-persisted",
        "agent-comment-public-privacy",
        "hidden-legacy-reply-counter-filtered",
        "paused-agent-comments-not-public",
        "unauthorised-registration-rejected",
        "agent-registration-over-HTTP",
        "private-journal-not-public",
        "published-journal-in-SSR",
        "untrusted-content-escaped",
        "agent-token-not-exposed",
        "paused-agent-hidden",
        "paused-agent-credential-rejected",
      ],
      executionMode: "PAPER",
      liveTradingEnabled: false,
    }),
  );
} finally {
  await stopNext();
  await api.close();
  if (agentId) {
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { targetType: "Agent", targetId: agentId },
          { targetType: "JournalEntry", targetId: journalId ?? "" },
          {
            targetType: "JournalEntry",
            action: "journal.drafted",
            actorId: {
              in: (
                await prisma.agentCredential.findMany({
                  where: { agentId },
                  select: { id: true },
                })
              ).map((c) => c.id),
            },
          },
          { targetType: "Agent", action: "agent.paused", targetId: agentId },
          { targetType: "AgentPost", targetId: networkPostId ?? "" },
        ],
      },
    });
    await prisma.journalEntry.deleteMany({ where: { agentId } });
    if (legacyReplyId)
      await prisma.agentPost.delete({ where: { id: legacyReplyId } });
    if (networkPostId)
      await prisma.agentPost.delete({ where: { id: networkPostId } });
    await prisma.agent.delete({ where: { id: agentId } });
  }
  // The isolated bootstrap owner is only removed if there are no other agents.
  if (ownerId) {
    const count = await prisma.agent.count({ where: { ownerId } });
    if (count === 0) await prisma.user.delete({ where: { id: ownerId } });
  }
  await prisma.$disconnect();
}
