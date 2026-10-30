import { randomUUID } from "node:crypto";

export type WorkerJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "DEAD_LETTER"
  | "CANCELLED";

export interface WorkerJob<TPayload = unknown> {
  id: string;
  queue: string;
  kind: string;
  payload: TPayload;
  status: WorkerJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  idempotencyKey: string | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface WorkerQueueDatabase {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface EnqueueJob<TPayload> {
  queue: string;
  kind: string;
  payload: TPayload;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
  idempotencyKey?: string;
}
export interface WorkerQueueOptions {
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  maxErrorLength?: number;
}
export interface WorkerQueueStats {
  queue: string;
  queued: number;
  retryWait: number;
  running: number;
  succeeded: number;
  deadLetter: number;
  cancelled: number;
  queueDepth: number;
  oldestPendingAgeMs: number | null;
  expiredLeases: number;
  sampledAt: string;
}
const DEFAULTS: Required<WorkerQueueOptions> = {
  leaseMs: 30_000,
  baseRetryMs: 1_000,
  maxRetryMs: 300_000,
  maxErrorLength: 2_000,
};

function requireBoundedString(value: string, label: string, max: number): void {
  if (!value.trim() || value.length > max)
    throw new Error(`${label} must be 1..${max} characters`);
}
function retryDelay(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(
    max,
    base * 2 ** Math.min(Math.max(attempt - 1, 0), 30),
  );
  return Math.floor(ceiling * (0.8 + Math.random() * 0.4));
}

/**
 * PostgreSQL-backed at-least-once queue. Handlers must be idempotent.
 * The returned lockedBy value is a per-claim fencing token; pass it unchanged
 * to heartbeat/complete/fail rather than passing the worker's stable name.
 */
export class WorkerQueue {
  private readonly options: Required<WorkerQueueOptions>;
  constructor(
    private readonly db: WorkerQueueDatabase,
    options: WorkerQueueOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${key} must be a positive finite number`);
    }
  }

  async enqueue<TPayload>(
    input: EnqueueJob<TPayload>,
  ): Promise<WorkerJob<TPayload>> {
    requireBoundedString(input.queue, "queue", 100);
    requireBoundedString(input.kind, "kind", 160);
    if (input.idempotencyKey !== undefined)
      requireBoundedString(input.idempotencyKey, "idempotencyKey", 200);
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new Error("maxAttempts must be an integer between 1 and 100");
    const priority = input.priority ?? 0;
    if (
      !Number.isInteger(priority) ||
      priority < -1_000_000 ||
      priority > 1_000_000
    )
      throw new Error(
        "priority must be an integer between -1000000 and 1000000",
      );
    const serializedPayload = JSON.stringify(input.payload);
    if (serializedPayload === undefined)
      throw new Error("payload must be JSON-serializable");

    const rows = await this.db.$queryRawUnsafe<WorkerJob<TPayload>[]>(
      `INSERT INTO "WorkerJob" ("id","queue","kind","payload","status","priority","maxAttempts","availableAt","idempotencyKey","updatedAt")
       VALUES ($1::uuid,$2,$3,$4::jsonb,'QUEUED',$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON CONFLICT ("queue","idempotencyKey") DO UPDATE SET "idempotencyKey" = EXCLUDED."idempotencyKey"
         WHERE "WorkerJob"."kind" = EXCLUDED."kind" AND "WorkerJob"."payload" = EXCLUDED."payload"
       RETURNING *`,
      randomUUID(),
      input.queue,
      input.kind,
      serializedPayload,
      priority,
      maxAttempts,
      input.availableAt ?? new Date(),
      input.idempotencyKey ?? null,
    );
    if (!rows[0]) throw new Error("enqueue returned no persisted job");
    return rows[0];
  }

  async claim(queue: string, workerId: string): Promise<WorkerJob | null> {
    requireBoundedString(queue, "queue", 100);
    requireBoundedString(workerId, "workerId", 160);
    // If a process died on its final allowed attempt, no handler can call fail().
    // Reap that expired lease before selecting more work so it cannot remain RUNNING forever.
    await this.db.$executeRawUnsafe(
      `UPDATE "WorkerJob"
       SET "status" = 'DEAD_LETTER',
           "lastError" = COALESCE("lastError", 'Worker lease expired after maximum attempts'),
           "lockedAt" = NULL, "lockedBy" = NULL,
           "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "queue" = $1 AND "status" = 'RUNNING' AND "attempts" >= "maxAttempts"
         AND "lockedAt" < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond')`,
      queue,
      this.options.leaseMs,
    );
    const leaseOwnerToken = `${workerId}:${randomUUID()}`;
    const rows = await this.db.$queryRawUnsafe<WorkerJob[]>(
      `WITH candidate AS (
         SELECT "id" FROM "WorkerJob"
         WHERE "queue" = $1 AND "availableAt" <= CURRENT_TIMESTAMP
           AND ("status" IN ('QUEUED','RETRY_WAIT') OR
             ("status" = 'RUNNING' AND "attempts" < "maxAttempts" AND "lockedAt" < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond')))
         ORDER BY "priority" DESC, "availableAt" ASC, "createdAt" ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE "WorkerJob" AS job
       SET "status" = 'RUNNING', "attempts" = job."attempts" + 1,
           "lockedAt" = CURRENT_TIMESTAMP, "lockedBy" = $3, "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       FROM candidate WHERE job."id" = candidate."id" RETURNING job.*`,
      queue,
      this.options.leaseMs,
      leaseOwnerToken,
    );
    return rows[0] ?? null;
  }

  async heartbeat(
    jobId: string,
    leaseOwnerToken: string,
    leaseAt: Date,
  ): Promise<Date | null> {
    const rows = await this.db.$queryRawUnsafe<Array<{ lockedAt: Date }>>(
      `UPDATE "WorkerJob" SET "lockedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2
         AND date_trunc('milliseconds', "lockedAt") = $3
         AND "lockedAt" >= CURRENT_TIMESTAMP - ($4 * INTERVAL '1 millisecond')
       RETURNING "lockedAt"`,
      jobId,
      leaseOwnerToken,
      leaseAt,
      this.options.leaseMs,
    );
    return rows[0]?.lockedAt ?? null;
  }

  async complete(
    jobId: string,
    leaseOwnerToken: string,
    leaseAt: Date,
  ): Promise<boolean> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "WorkerJob" SET "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP,
         "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2
         AND date_trunc('milliseconds', "lockedAt") = $3
         AND "lockedAt" >= CURRENT_TIMESTAMP - ($4 * INTERVAL '1 millisecond')
       RETURNING "id"`,
      jobId,
      leaseOwnerToken,
      leaseAt,
      this.options.leaseMs,
    );
    return rows.length === 1;
  }

  async fail(
    jobId: string,
    leaseOwnerToken: string,
    leaseAt: Date,
    error: unknown,
  ): Promise<"RETRY_WAIT" | "DEAD_LETTER" | "LEASE_LOST"> {
    const jobs = await this.db.$queryRawUnsafe<
      Array<Pick<WorkerJob, "id" | "attempts" | "maxAttempts">>
    >(
      `SELECT "id","attempts","maxAttempts" FROM "WorkerJob"
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2
         AND date_trunc('milliseconds', "lockedAt") = $3
         AND "lockedAt" >= CURRENT_TIMESTAMP - ($4 * INTERVAL '1 millisecond')`,
      jobId,
      leaseOwnerToken,
      leaseAt,
      this.options.leaseMs,
    );
    const job = jobs[0];
    if (!job) return "LEASE_LOST";
    const terminal = job.attempts >= job.maxAttempts;
    const status = terminal ? "DEAD_LETTER" : "RETRY_WAIT";
    const delay = retryDelay(
      job.attempts,
      this.options.baseRetryMs,
      this.options.maxRetryMs,
    );
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, this.options.maxErrorLength);
    const result = await this.db.$executeRawUnsafe(
      `UPDATE "WorkerJob" SET "status" = $4::"WorkerJobStatus",
         "availableAt" = CASE WHEN $4 = 'RETRY_WAIT' THEN CURRENT_TIMESTAMP + ($5 * INTERVAL '1 millisecond') ELSE "availableAt" END,
         "lastError" = $6, "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2
         AND date_trunc('milliseconds', "lockedAt") = $3
         AND "lockedAt" >= CURRENT_TIMESTAMP - ($7 * INTERVAL '1 millisecond')`,
      jobId,
      leaseOwnerToken,
      leaseAt,
      status,
      delay,
      message,
      this.options.leaseMs,
    );
    return result === 1 ? status : "LEASE_LOST";
  }

  async stats(queue: string): Promise<WorkerQueueStats> {
    requireBoundedString(queue, "queue", 100);
    type StatsRow = {
      queued: number | string;
      retryWait: number | string;
      running: number | string;
      succeeded: number | string;
      deadLetter: number | string;
      cancelled: number | string;
      oldestPendingAgeMs: number | string | null;
      expiredLeases: number | string;
    };
    const rows = await this.db.$queryRawUnsafe<StatsRow[]>(
      `SELECT
         COUNT(*) FILTER (WHERE "status" = 'QUEUED')::int AS "queued",
         COUNT(*) FILTER (WHERE "status" = 'RETRY_WAIT')::int AS "retryWait",
         COUNT(*) FILTER (WHERE "status" = 'RUNNING')::int AS "running",
         COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED')::int AS "succeeded",
         COUNT(*) FILTER (WHERE "status" = 'DEAD_LETTER')::int AS "deadLetter",
         COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::int AS "cancelled",
         EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt") FILTER (WHERE "status" IN ('QUEUED','RETRY_WAIT')))) * 1000 AS "oldestPendingAgeMs",
         COUNT(*) FILTER (WHERE "status" = 'RUNNING' AND "lockedAt" < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond'))::int AS "expiredLeases"
       FROM "WorkerJob" WHERE "queue" = $1`,
      queue,
      this.options.leaseMs,
    );
    const row = rows[0];
    if (!row) throw new Error("queue stats query returned no aggregate row");
    const queued = Number(row.queued);
    const retryWait = Number(row.retryWait);
    const running = Number(row.running);
    const succeeded = Number(row.succeeded);
    const deadLetter = Number(row.deadLetter);
    const cancelled = Number(row.cancelled);
    const oldestPendingAgeMs =
      row.oldestPendingAgeMs === null
        ? null
        : Math.max(0, Number(row.oldestPendingAgeMs));
    const expiredLeases = Number(row.expiredLeases);
    if (
      ![
        queued,
        retryWait,
        running,
        succeeded,
        deadLetter,
        cancelled,
        expiredLeases,
      ].every(Number.isSafeInteger) ||
      [
        queued,
        retryWait,
        running,
        succeeded,
        deadLetter,
        cancelled,
        expiredLeases,
      ].some((value) => value < 0) ||
      (oldestPendingAgeMs !== null &&
        (!Number.isFinite(oldestPendingAgeMs) || oldestPendingAgeMs < 0))
    ) {
      throw new Error("queue stats query returned invalid numeric values");
    }
    return {
      queue,
      queued,
      retryWait,
      running,
      succeeded,
      deadLetter,
      cancelled,
      queueDepth: queued + retryWait,
      oldestPendingAgeMs,
      expiredLeases,
      sampledAt: new Date().toISOString(),
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    return (
      (await this.db.$executeRawUnsafe(
        `UPDATE "WorkerJob" SET "status" = 'CANCELLED', "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" IN ('QUEUED','RETRY_WAIT')`,
        jobId,
      )) === 1
    );
  }
}
