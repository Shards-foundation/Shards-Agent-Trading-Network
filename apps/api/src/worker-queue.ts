import { randomUUID } from "node:crypto";

export type WorkerJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "RETRY_WAIT" | "DEAD_LETTER" | "CANCELLED";

export interface WorkerJob<TPayload = unknown> {
  id: string; queue: string; kind: string; payload: TPayload; status: WorkerJobStatus;
  priority: number; attempts: number; maxAttempts: number; availableAt: Date;
  lockedAt: Date | null; lockedBy: string | null; idempotencyKey: string | null;
  lastError: string | null; completedAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface WorkerQueueDatabase {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface EnqueueJob<TPayload> {
  queue: string; kind: string; payload: TPayload; priority?: number;
  maxAttempts?: number; availableAt?: Date; idempotencyKey?: string;
}
export interface WorkerQueueOptions {
  leaseMs?: number; baseRetryMs?: number; maxRetryMs?: number; maxErrorLength?: number;
}
const DEFAULTS: Required<WorkerQueueOptions> = { leaseMs: 30_000, baseRetryMs: 1_000, maxRetryMs: 300_000, maxErrorLength: 2_000 };

function requireBoundedString(value: string, label: string, max: number): void {
  if (!value.trim() || value.length > max) throw new Error(`${label} must be 1..${max} characters`);
}
function retryDelay(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.floor(ceiling * (0.8 + Math.random() * 0.4));
}

/**
 * PostgreSQL-backed at-least-once queue. Handlers must be idempotent.
 * The returned lockedBy value is a per-claim fencing token; pass it unchanged
 * to heartbeat/complete/fail rather than passing the worker's stable name.
 */
export class WorkerQueue {
  private readonly options: Required<WorkerQueueOptions>;
  constructor(private readonly db: WorkerQueueDatabase, options: WorkerQueueOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number`);
    }
  }

  async enqueue<TPayload>(input: EnqueueJob<TPayload>): Promise<WorkerJob<TPayload>> {
    requireBoundedString(input.queue, "queue", 100);
    requireBoundedString(input.kind, "kind", 160);
    if (input.idempotencyKey !== undefined) requireBoundedString(input.idempotencyKey, "idempotencyKey", 200);
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("maxAttempts must be an integer between 1 and 100");
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -1_000_000 || priority > 1_000_000) throw new Error("priority must be an integer between -1000000 and 1000000");

    const rows = await this.db.$queryRawUnsafe<WorkerJob<TPayload>[]>(
      `INSERT INTO "WorkerJob" ("id","queue","kind","payload","status","priority","maxAttempts","availableAt","idempotencyKey","updatedAt")
       VALUES ($1::uuid,$2,$3,$4::jsonb,'QUEUED',$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON CONFLICT ("queue","idempotencyKey") DO UPDATE SET "idempotencyKey" = EXCLUDED."idempotencyKey"
       RETURNING *`,
      randomUUID(), input.queue, input.kind, JSON.stringify(input.payload), priority, maxAttempts,
      input.availableAt ?? new Date(), input.idempotencyKey ?? null,
    );
    if (!rows[0]) throw new Error("enqueue returned no persisted job");
    return rows[0];
  }

  async claim(queue: string, workerId: string): Promise<WorkerJob | null> {
    requireBoundedString(queue, "queue", 100);
    requireBoundedString(workerId, "workerId", 200);
    const now = new Date();
    const expiredBefore = new Date(now.getTime() - this.options.leaseMs);
    const leaseOwnerToken = `${workerId}:${randomUUID()}`;
    const rows = await this.db.$queryRawUnsafe<WorkerJob[]>(
      `WITH candidate AS (
         SELECT "id" FROM "WorkerJob"
         WHERE "queue" = $1 AND "availableAt" <= $2
           AND ("status" IN ('QUEUED','RETRY_WAIT') OR ("status" = 'RUNNING' AND "lockedAt" < $3))
         ORDER BY "priority" DESC, "availableAt" ASC, "createdAt" ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE "WorkerJob" AS job
       SET "status" = 'RUNNING', "attempts" = job."attempts" + 1,
           "lockedAt" = $4, "lockedBy" = $5, "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       FROM candidate WHERE job."id" = candidate."id" RETURNING job.*`,
      queue, now, expiredBefore, now, leaseOwnerToken,
    );
    return rows[0] ?? null;
  }

  async heartbeat(jobId: string, leaseOwnerToken: string, leaseAt: Date): Promise<boolean> {
    const renewedAt = new Date();
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "WorkerJob" SET "lockedAt" = $4, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2 AND "lockedAt" = $3 RETURNING "id"`,
      jobId, leaseOwnerToken, leaseAt, renewedAt,
    );
    return rows.length === 1;
  }

  async complete(jobId: string, leaseOwnerToken: string, leaseAt: Date): Promise<boolean> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "WorkerJob" SET "status" = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP,
         "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2 AND "lockedAt" = $3 RETURNING "id"`,
      jobId, leaseOwnerToken, leaseAt,
    );
    return rows.length === 1;
  }

  async fail(jobId: string, leaseOwnerToken: string, leaseAt: Date, error: unknown): Promise<"RETRY_WAIT" | "DEAD_LETTER" | "LEASE_LOST"> {
    const jobs = await this.db.$queryRawUnsafe<Array<Pick<WorkerJob, "id" | "attempts" | "maxAttempts">>>(
      `SELECT "id","attempts","maxAttempts" FROM "WorkerJob"
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2 AND "lockedAt" = $3`,
      jobId, leaseOwnerToken, leaseAt,
    );
    const job = jobs[0];
    if (!job) return "LEASE_LOST";
    const terminal = job.attempts >= job.maxAttempts;
    const status = terminal ? "DEAD_LETTER" : "RETRY_WAIT";
    const delay = retryDelay(job.attempts, this.options.baseRetryMs, this.options.maxRetryMs);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, this.options.maxErrorLength);
    const result = await this.db.$executeRawUnsafe(
      `UPDATE "WorkerJob" SET "status" = $4::"WorkerJobStatus",
         "availableAt" = CASE WHEN $4 = 'RETRY_WAIT' THEN CURRENT_TIMESTAMP + ($5 * INTERVAL '1 millisecond') ELSE "availableAt" END,
         "lastError" = $6, "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" = 'RUNNING' AND "lockedBy" = $2 AND "lockedAt" = $3`,
      jobId, leaseOwnerToken, leaseAt, status, delay, message,
    );
    return result === 1 ? status : "LEASE_LOST";
  }

  async cancel(jobId: string): Promise<boolean> {
    return (await this.db.$executeRawUnsafe(
      `UPDATE "WorkerJob" SET "status" = 'CANCELLED', "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid AND "status" IN ('QUEUED','RETRY_WAIT')`,
      jobId,
    )) === 1;
  }
}
