import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { buildServer } from "../dist/index.js";
import { WorkerQueue } from "../dist/worker-queue.js";

// A black-box release gate for the built API and real worker process.
// Requires an isolated, migrated PostgreSQL database and Redis instance.
// No venue writes or live trading functionality is exercised.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
assert.ok(process.env.REDIS_URL, "REDIS_URL is required");
assert.equal(process.env.LIVE_EXECUTION_ENABLED, "false");
assert.equal(process.env.EXECUTION_MODE, "PAPER");

const queueName = `smoke-${randomUUID()}`;
// The production API probe and the worker MUST inspect the same test queue.
process.env.WORKER_QUEUE = queueName;
process.env.WORKER_STALE_AFTER_MS = "900";
const workerPath = fileURLToPath(new URL("../dist/worker-main.js", import.meta.url));
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const prisma = new PrismaClient();
const queue = new WorkerQueue(prisma, { leaseMs: 1_500 });
const app = buildServer();
const children = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`, {
    cause: lastError,
  });
}

function launchWorker() {
  const child = spawn(process.execPath, [workerPath], {
    cwd: apiRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      WORKER_QUEUE: queueName,
      WORKER_HEARTBEAT_MS: "200",
      WORKER_STALE_AFTER_MS: "900",
      WORKER_LEASE_MS: "1500",
      WORKER_SHUTDOWN_GRACE_MS: "400",
      WORKER_METRICS_INTERVAL_MS: "2000",
      EXECUTION_MODE: "PAPER",
      LIVE_EXECUTION_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  children.push(child);
  return child;
}

function signalAndWait(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      resolve({ code, signal: exitSignal });
    });
    if (!child.kill(signal)) reject(new Error(`Could not send ${signal} to worker`));
  });
}

async function jobState(jobId) {
  const rows = await prisma.$queryRaw`
    SELECT "status"::text AS "status", "attempts"
    FROM "WorkerJob" WHERE "id" = ${jobId}::uuid
  `;
  return rows[0] ?? null;
}

let address;
try {
  // Test the actual HTTP listener and default production dependency probes.
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  const readiness = async () => {
    const response = await fetch(new URL("/health/ready", address), {
      signal: AbortSignal.timeout(2_000),
    });
    return { httpStatus: response.status, body: await response.json() };
  };
  const isReady = async (expected) => {
    const response = await readiness();
    assert.equal(response.body.execution.liveEnabled, false);
    assert.equal(response.body.execution.mode, "PAPER");
    return (
      response.httpStatus === expected &&
      response.body.dependencies.worker ===
        (expected === 200 ? "connected" : "unavailable")
    );
  };

  assert.equal((await readiness()).httpStatus, 503);
  const first = launchWorker();
  await eventually(() => isReady(200), "first worker readiness");

  const firstJob = await queue.enqueue({
    queue: queueName,
    kind: "system.healthcheck",
    payload: { smoke: true },
    maxAttempts: 2,
  });
  await eventually(
    async () => (await jobState(firstJob.id))?.status === "SUCCEEDED",
    "healthcheck job completion",
  );

  const gracefulExit = await signalAndWait(first, "SIGTERM");
  assert.equal(gracefulExit.code, 0, "SIGTERM must exit successfully");
  await eventually(() => isReady(503), "readiness after graceful shutdown");

  const second = launchWorker();
  await eventually(() => isReady(200), "readiness after worker restart");

  const killedExit = await signalAndWait(second, "SIGKILL");
  assert.equal(killedExit.signal, "SIGKILL");
  await eventually(() => isReady(503), "stale heartbeat after SIGKILL");

  // Model a crash after a PostgreSQL claim but before an acknowledgment.
  const retryJob = await queue.enqueue({
    queue: queueName,
    kind: "system.healthcheck",
    payload: { leaseRecovery: true },
    maxAttempts: 2,
  });
  const crashedClaim = await queue.claim(queueName, "simulated-crashed-handler");
  assert.equal(crashedClaim?.id, retryJob.id);
  assert.equal(crashedClaim?.attempts, 1);

  // A new real worker must reclaim only after the old lease expires.
  const third = launchWorker();
  await eventually(
    async () => {
      const state = await jobState(retryJob.id);
      return state?.status === "SUCCEEDED" && state.attempts === 2;
    },
    "expired claim recovery with a second attempt",
  );
  assert.equal(
    await queue.complete(
      crashedClaim.id,
      crashedClaim.lockedBy,
      crashedClaim.lockedAt,
    ),
    false,
    "stale worker must not acknowledge a reclaimed job",
  );
  await eventually(() => isReady(200), "restarted worker readiness");
  const finalExit = await signalAndWait(third, "SIGTERM");
  assert.equal(finalExit.code, 0);
  await eventually(() => isReady(503), "final graceful shutdown");

  console.info(
    JSON.stringify({
      event: "smoke.worker_lifecycle.passed",
      scenarios: [
        "readiness-closed-before-worker",
        "readiness-open-with-fresh-worker",
        "durable-job-execution",
        "graceful-shutdown",
        "restart",
        "SIGKILL-stale-heartbeat",
        "expired-lease-recovery",
        "fenced-stale-acknowledgment",
      ],
      liveTradingEnabled: false,
    }),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await signalAndWait(child, "SIGKILL");
    }
  }
  await app.close();
  await prisma.$executeRaw`DELETE FROM "WorkerJob" WHERE "queue" = ${queueName}`;
  await prisma.$executeRaw`DELETE FROM "WorkerHeartbeat" WHERE "queue" = ${queueName}`;
  await prisma.$disconnect();
}
