import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { PrismaClient } from "@prisma/client";
import { WorkerQueue } from "./worker-queue.js";
import { WorkerRunner, type WorkerHandler } from "./worker-runner.js";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for the worker process.");

const queueName = process.env.WORKER_QUEUE ?? "default";
if (!queueName.trim() || queueName.length > 100)
  throw new Error("WORKER_QUEUE must be 1..100 characters.");

const heartbeatMs = positiveInteger("WORKER_HEARTBEAT_MS", 5_000);
const leaseMs = positiveInteger("WORKER_LEASE_MS", 30_000);
const staleAfterMs = positiveInteger("WORKER_STALE_AFTER_MS", 30_000);
const metricsIntervalMs = positiveInteger("WORKER_METRICS_INTERVAL_MS", 60_000);
if (heartbeatMs >= staleAfterMs) {
  throw new Error(
    "WORKER_HEARTBEAT_MS must be lower than WORKER_STALE_AFTER_MS.",
  );
}

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const prisma = new PrismaClient();
const queue = new WorkerQueue(prisma, { leaseMs });
const handlers = new Map<string, WorkerHandler>([
  [
    "system.healthcheck",
    async (payload, context) => {
      if (context.signal.aborted) throw new Error("healthcheck cancelled");
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new Error("system.healthcheck payload must be a JSON object");
      }
      // This handler intentionally performs no external side effects.
    },
  ],
]);
const runner = new WorkerRunner(queue, queueName, workerId, handlers, {
  leaseMs,
});
const shutdown = new AbortController();
let heartbeatInFlight: Promise<void> | undefined;
let stopping = false;
let shutdownReason = "RUN_LOOP_EXIT";

async function persistHeartbeat(status: "RUNNING" | "STOPPED"): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "WorkerHeartbeat" ("workerId","queue","status","startedAt","lastSeenAt","stoppedAt","updatedAt")
     VALUES ($1,$2,$3::"WorkerProcessStatus",CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
       CASE WHEN $3 = 'STOPPED' THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP)
     ON CONFLICT ("workerId") DO UPDATE SET
       "status" = EXCLUDED."status",
       "lastSeenAt" = CURRENT_TIMESTAMP,
       "stoppedAt" = CASE WHEN EXCLUDED."status" = 'STOPPED' THEN CURRENT_TIMESTAMP ELSE NULL END,
       "updatedAt" = CURRENT_TIMESTAMP`,
    workerId,
    queueName,
    status,
  );
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(
    JSON.stringify({
      event: "worker.shutdown.started",
      workerId,
      signal,
      at: new Date().toISOString(),
    }),
  );
  shutdown.abort();
  clearInterval(heartbeatTimer);
  clearInterval(metricsTimer);
  await heartbeatInFlight;
  try {
    await persistHeartbeat("STOPPED");
  } catch {
    console.error(
      JSON.stringify({ event: "worker.heartbeat.stop_failed", workerId }),
    );
  }
  await prisma.$disconnect();
  console.info(
    JSON.stringify({
      event: "worker.shutdown.completed",
      workerId,
      at: new Date().toISOString(),
    }),
  );
}

async function logQueueStats(): Promise<void> {
  try {
    const stats = await queue.stats(queueName);
    console.info(
      JSON.stringify({ event: "worker.queue.stats", workerId, ...stats }),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "worker.queue.stats_failed",
        workerId,
        queue: queueName,
        at: new Date().toISOString(),
      }),
    );
  }
}

const metricsTimer = setInterval(() => {
  void logQueueStats();
}, metricsIntervalMs);
metricsTimer.unref();

const heartbeatTimer = setInterval(() => {
  if (heartbeatInFlight || stopping) return;
  heartbeatInFlight = persistHeartbeat("RUNNING")
    .catch(() => {
      console.error(
        JSON.stringify({ event: "worker.heartbeat.failed", workerId }),
      );
      shutdown.abort(new Error("worker heartbeat persistence failed"));
    })
    .finally(() => {
      heartbeatInFlight = undefined;
    });
}, heartbeatMs);
heartbeatTimer.unref();

process.once("SIGTERM", () => {
  shutdownReason = "SIGTERM";
  shutdown.abort();
});
process.once("SIGINT", () => {
  shutdownReason = "SIGINT";
  shutdown.abort();
});

try {
  await persistHeartbeat("RUNNING");
  console.info(
    JSON.stringify({
      event: "worker.started",
      workerId,
      queue: queueName,
      heartbeatMs,
      leaseMs,
      staleAfterMs,
      metricsIntervalMs,
      registeredHandlers: [...handlers.keys()],
      liveTradingEnabled: false,
      at: new Date().toISOString(),
    }),
  );
  await runner.run(shutdown.signal);
} catch {
  console.error(
    JSON.stringify({
      event: "worker.fatal",
      workerId,
      at: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
} finally {
  if (!stopping) await stop(shutdownReason);
}
