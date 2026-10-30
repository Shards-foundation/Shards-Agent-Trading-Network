import { describe, expect, it, vi } from "vitest";
import { WorkerQueue, type WorkerQueueDatabase, type WorkerJob } from "./worker-queue.js";

function fakeDb(): WorkerQueueDatabase & {
  query: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(),
    execute: vi.fn(),
    $queryRawUnsafe: vi.fn(async (...args: unknown[]) => {
      return await (fakeDbRef.query as (args: unknown[]) => Promise<unknown>)(args);
    }) as WorkerQueueDatabase["$queryRawUnsafe"],
    $executeRawUnsafe: vi.fn(async (...args: unknown[]) => {
      return await (fakeDbRef.execute as (args: unknown[]) => Promise<number>)(args);
    }),
  };
}

// Shared dispatch avoids hiding the raw SQL/parameter contract in the fake.
let fakeDbRef: { query: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };

const claimedJob = (): WorkerJob => ({
  id: "e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111",
  queue: "default",
  kind: "sample",
  payload: { value: 1 },
  status: "RUNNING",
  priority: 0,
  attempts: 1,
  maxAttempts: 3,
  availableAt: new Date(),
  lockedAt: new Date("2026-10-30T12:00:00.001Z"),
  lockedBy: "worker-a",
  idempotencyKey: null,
  lastError: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("WorkerQueue", () => {
  it("rejects invalid enqueue metadata before touching the database", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    const queue = new WorkerQueue(db);
    await expect(queue.enqueue({ queue: " ", kind: "sample", payload: {} })).rejects.toThrow("queue");
    await expect(queue.enqueue({ queue: "default", kind: "sample", payload: {}, maxAttempts: 0 })).rejects.toThrow("maxAttempts");
    await expect(queue.enqueue({ queue: "default", kind: "sample", payload: undefined })).rejects.toThrow("JSON-serializable");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("persists an enqueue using bound parameters and returns the row", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    const row = { ...claimedJob(), status: "QUEUED" as const };
    db.query.mockResolvedValue([row]);
    const queue = new WorkerQueue(db);
    const result = await queue.enqueue({
      queue: "default",
      kind: "sample",
      payload: { safe: true },
      idempotencyKey: "event-123",
    });
    expect(result.id).toBe(row.id);
    const [sql, ...params] = db.query.mock.calls[0]![0] as [string, ...unknown[]];
    expect(sql).toContain('ON CONFLICT ("queue","idempotencyKey")');
    expect(sql).toContain("RETURNING *");
    expect(params).toContain("event-123");
    expect(params).toContain(JSON.stringify({ safe: true }));
  });

  it("fails closed when an idempotency key is reused with a different payload", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    db.query.mockResolvedValue([]);
    const queue = new WorkerQueue(db);
    await expect(queue.enqueue({ queue: "default", kind: "sample", payload: { value: "different" }, idempotencyKey: "same-key" }))
      .rejects.toThrow("enqueue returned no persisted job");
  });

  it("claims work with SKIP LOCKED and recovers expired running leases", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    const row = claimedJob();
    db.query.mockResolvedValue([row]);
    const queue = new WorkerQueue(db);
    const result = await queue.claim("default", "worker-a");
    expect(result).toEqual(row);
    const [sql] = db.query.mock.calls[0]![0] as [string];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain('"status" = \'RUNNING\' AND "lockedAt" <');
  });

  it("returns the renewed timestamp so a worker can complete with the current lease", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    const renewed = new Date("2026-10-30T12:00:30.000Z");
    db.query.mockResolvedValue([{ lockedAt: renewed }]);
    const queue = new WorkerQueue(db);
    await expect(queue.heartbeat("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111", "worker-a:claim-token", new Date()))
      .resolves.toEqual(renewed);
  });

  it("does not allow a stale lease to complete a job", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    db.query.mockResolvedValue([]);
    const queue = new WorkerQueue(db);
    const ok = await queue.complete("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111", "worker-a", new Date());
    expect(ok).toBe(false);
    const [sql, ...params] = db.query.mock.calls[0]![0] as [string, ...unknown[]];
    expect(sql).toContain('"lockedBy" = $2 AND "lockedAt" = $3');
    expect(params).toHaveLength(3);
  });

  it("returns LEASE_LOST rather than mutating a job after ownership changes", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    db.query.mockResolvedValue([]);
    const queue = new WorkerQueue(db);
    await expect(queue.fail("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111", "worker-a", new Date(), new Error("oops")))
      .resolves.toBe("LEASE_LOST");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("caps persisted error text and retries only while attempts remain", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    db.query.mockResolvedValue([{ id: "job", attempts: 1, maxAttempts: 2 }]);
    db.execute.mockResolvedValue(1);
    const queue = new WorkerQueue(db, { baseRetryMs: 10, maxRetryMs: 20, maxErrorLength: 5 });
    const outcome = await queue.fail("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111", "worker-a", new Date(), new Error("too-long-error"));
    expect(outcome).toBe("RETRY_WAIT");
    const [, , , status, delay, message] = db.execute.mock.calls[0]![0] as unknown[];
    expect(status).toBe("RETRY_WAIT");
    expect(Number(delay)).toBeGreaterThan(0);
    expect(message).toBe("too-l");
  });

  it("dead-letters exhausted jobs and allows cancellation only before claim", async () => {
    const db = fakeDb();
    fakeDbRef = db;
    db.query.mockResolvedValue([{ id: "job", attempts: 3, maxAttempts: 3 }]);
    db.execute.mockResolvedValue(1);
    const queue = new WorkerQueue(db);
    await expect(queue.fail("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111", "worker-a", new Date(), "fatal"))
      .resolves.toBe("DEAD_LETTER");
    expect(await queue.cancel("e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111")).toBe(true);
    const [sql] = db.execute.mock.calls[1]![0] as [string];
    expect(sql).toContain('"status" IN (\'QUEUED\',\'RETRY_WAIT\')');
  });
});
