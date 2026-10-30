import { describe, expect, it, vi } from "vitest";
import { WorkerRunner } from "./worker-runner.js";
import type { WorkerJob, WorkerQueue } from "./worker-queue.js";

const job: WorkerJob = {
  id: "e0a4c9d0-3c5e-4df9-8e15-6ad8bcbde111",
  queue: "default",
  kind: "test",
  payload: { value: 1 },
  status: "RUNNING",
  priority: 0,
  attempts: 1,
  maxAttempts: 3,
  availableAt: new Date(),
  lockedAt: new Date("2026-10-30T12:00:00.000Z"),
  lockedBy: "worker-a:unique-claim-token",
  idempotencyKey: null,
  lastError: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function queueMock() {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  } as unknown as WorkerQueue & {
    claim: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
  };
}

describe("WorkerRunner", () => {
  it("returns IDLE when no job is ready", async () => {
    const queue = queueMock();
    queue.claim.mockResolvedValue(null);
    const runner = new WorkerRunner(queue, "default", "worker-a", new Map(), {
      leaseMs: 30,
      idlePollMs: 5,
      maxIdlePollMs: 10,
    });
    await expect(runner.runOne()).resolves.toEqual({ outcome: "IDLE" });
  });

  it("executes a registered handler and completes using the claimed fencing token", async () => {
    const queue = queueMock();
    queue.claim.mockResolvedValue(job);
    queue.complete.mockResolvedValue(true);
    const handler = vi.fn(async () => undefined);
    const runner = new WorkerRunner(
      queue,
      "default",
      "worker-a",
      new Map([["test", handler]]),
      { leaseMs: 30, idlePollMs: 5, maxIdlePollMs: 10 },
    );
    await expect(runner.runOne()).resolves.toEqual({
      outcome: "SUCCEEDED",
      jobId: job.id,
    });
    expect(handler).toHaveBeenCalledWith(
      job.payload,
      expect.objectContaining({ job, signal: expect.any(AbortSignal) }),
    );
    expect(queue.complete).toHaveBeenCalledWith(
      job.id,
      job.lockedBy,
      job.lockedAt,
    );
  });

  it("fails closed for unknown job kinds instead of silently acknowledging them", async () => {
    const queue = queueMock();
    queue.claim.mockResolvedValue(job);
    queue.fail.mockResolvedValue("DEAD_LETTER");
    const runner = new WorkerRunner(queue, "default", "worker-a", new Map(), {
      leaseMs: 30,
      idlePollMs: 5,
      maxIdlePollMs: 10,
    });
    await expect(runner.runOne()).resolves.toEqual({
      outcome: "DEAD_LETTER",
      jobId: job.id,
    });
    expect(queue.fail).toHaveBeenCalledWith(
      job.id,
      job.lockedBy,
      job.lockedAt,
      expect.any(Error),
    );
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("does not acknowledge a job if completion loses the lease", async () => {
    const queue = queueMock();
    queue.claim.mockResolvedValue(job);
    queue.complete.mockResolvedValue(false);
    const runner = new WorkerRunner(
      queue,
      "default",
      "worker-a",
      new Map([["test", vi.fn(async () => undefined)]]),
      { leaseMs: 30, idlePollMs: 5, maxIdlePollMs: 10 },
    );
    await expect(runner.runOne()).resolves.toEqual({
      outcome: "LEASE_LOST",
      jobId: job.id,
    });
  });

  it("does not start a claimed handler if shutdown arrives while claiming", async () => {
    const queue = queueMock();
    let resolveClaim!: (value: WorkerJob) => void;
    queue.claim.mockImplementation(
      () => new Promise<WorkerJob>((resolve) => {
        resolveClaim = resolve;
      }),
    );
    queue.fail.mockResolvedValue("RETRY_WAIT");
    const parent = new AbortController();
    const handler = vi.fn(async () => undefined);
    const runner = new WorkerRunner(
      queue,
      "default",
      "worker-a",
      new Map([["test", handler]]),
      { leaseMs: 30, idlePollMs: 5, maxIdlePollMs: 10 },
    );

    const running = runner.runOne(parent.signal);
    parent.abort(new Error("shutdown requested"));
    resolveClaim(job);

    await expect(running).resolves.toEqual({
      outcome: "RETRY_WAIT",
      jobId: job.id,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith(
      job.id,
      job.lockedBy,
      job.lockedAt,
      expect.any(Error),
    );
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("propagates shutdown abort to an active handler and retries cooperative cancellation", async () => {
    const queue = queueMock();
    queue.claim.mockResolvedValue(job);
    queue.fail.mockResolvedValue("RETRY_WAIT");
    const parent = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = vi.fn(
      (_payload: unknown, context: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          markStarted();
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    );
    const runner = new WorkerRunner(
      queue,
      "default",
      "worker-a",
      new Map([["test", handler]]),
      { leaseMs: 30, idlePollMs: 5, maxIdlePollMs: 10 },
    );

    const running = runner.runOne(parent.signal);
    await started;
    parent.abort(new Error("shutdown requested"));

    await expect(running).resolves.toEqual({
      outcome: "RETRY_WAIT",
      jobId: job.id,
    });
    expect(queue.fail).toHaveBeenCalledWith(
      job.id,
      job.lockedBy,
      job.lockedAt,
      expect.any(Error),
    );
    expect(queue.complete).not.toHaveBeenCalled();
  });
});
