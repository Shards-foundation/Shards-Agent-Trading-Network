import "./sentry.js";
import { captureBackendException } from "./sentry.js";
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
const shutdownGraceMs = positiveInteger("WORKER_SHUTDOWN_GRACE_MS", 10_000);
if (heartbeatMs >= staleAfterMs) {
  throw new Error(
    "WORKER_HEARTBEAT_MS must be lower than WORKER_STALE_AFTER_MS.",
  );
}
if (shutdownGraceMs * 2 >= leaseMs) {
  throw new Error(
    "WORKER_SHUTDOWN_GRACE_MS must be less than half of WORKER_LEASE_MS.",
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
let shutdownTimer: NodeJS.Timeout | undefined;
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

function requestShutdown(reason: string, error?: Error): void {
  shutdownReason = reason;
  if (!shutdown.signal.aborted) shutdown.abort(error);
  if (!shutdownTimer) {
    shutdownTimer = setTimeout(() => {
      console.error(
        JSON.stringify({
          event: "worker.shutdown.timeout",
          workerId,
          reason,
          shutdownGraceMs,
          at: new Date().toISOString(),
        }),
      );
      // A handler that ignores AbortSignal must not pin a failed worker forever.
      // Process termination leaves the job for lease-based recovery.
      process.exit(1);
    }, shutdownGraceMs);
  }
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  requestShutdown(signal);
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
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = undefined;
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
      process.exitCode = 1;
      requestShutdown(
        "HEARTBEAT_FAILURE",
        new Error("worker heartbeat persistence failed"),
      );
    })
    .finally(() => {
      heartbeatInFlight = undefined;
    });
}, heartbeatMs);
heartbeatTimer.unref();

process.once("SIGTERM", () => {
  requestShutdown("SIGTERM");
});
process.once("SIGINT", () => {
  requestShutdown("SIGINT");
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
      shutdownGraceMs,
      registeredHandlers: [...handlers.keys()],
      liveTradingEnabled: false,
      at: new Date().toISOString(),
    }),
  );
  await runner.run(shutdown.signal);
} catch (error) {
  captureBackendException(error);
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
