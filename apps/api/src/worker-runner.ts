import type { WorkerJob, WorkerQueue } from "./worker-queue.js";

export type WorkerHandler = (
  payload: unknown,
  context: { job: WorkerJob; signal: AbortSignal },
) => Promise<void>;

export interface WorkerRunnerOptions {
  leaseMs?: number;
  idlePollMs?: number;
  maxIdlePollMs?: number;
}

export type WorkerRunResult =
  | { outcome: "IDLE" }
  | { outcome: "SUCCEEDED"; jobId: string }
  | { outcome: "RETRY_WAIT" | "DEAD_LETTER" | "LEASE_LOST"; jobId: string };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Single-process worker loop. Run multiple instances for concurrency; queue
 * claiming uses PostgreSQL SKIP LOCKED. Delivery is at-least-once, not exactly-once.
 * Handlers must validate payloads and be idempotent. Never register live trading
 * handlers until their independent risk/permit gateway is implemented.
 */
export class WorkerRunner {
  private readonly leaseMs: number;
  private readonly idlePollMs: number;
  private readonly maxIdlePollMs: number;

  constructor(
    private readonly queue: WorkerQueue,
    private readonly queueName: string,
    private readonly workerId: string,
    private readonly handlers: ReadonlyMap<string, WorkerHandler>,
    options: WorkerRunnerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.idlePollMs = options.idlePollMs ?? 250;
    this.maxIdlePollMs = options.maxIdlePollMs ?? 5_000;
    for (const [name, value] of Object.entries({
      leaseMs: this.leaseMs,
      idlePollMs: this.idlePollMs,
      maxIdlePollMs: this.maxIdlePollMs,
    })) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${name} must be a positive finite number`);
    }
    if (this.idlePollMs > this.maxIdlePollMs)
      throw new Error("idlePollMs cannot exceed maxIdlePollMs");
  }

  async runOne(): Promise<WorkerRunResult> {
    const job = await this.queue.claim(this.queueName, this.workerId);
    if (!job) return { outcome: "IDLE" };
    if (!job.lockedAt || !job.lockedBy) {
      throw new Error(
        "claimed job is missing lease metadata; refusing to execute",
      );
    }

    const handler = this.handlers.get(job.kind);
    const controller = new AbortController();
    let leaseAt = job.lockedAt;
    let leaseLost = false;
    let heartbeatInFlight: Promise<void> | undefined;

    const heartbeatTimer = setInterval(
      () => {
        if (heartbeatInFlight || controller.signal.aborted || leaseLost) return;
        heartbeatInFlight = (async () => {
          try {
            const renewed = await this.queue.heartbeat(
              job.id,
              job.lockedBy!,
              leaseAt,
            );
            if (!renewed) {
              leaseLost = true;
              controller.abort(new Error("worker lease lost"));
              return;
            }
            leaseAt = renewed;
          } catch {
            leaseLost = true;
            controller.abort(new Error("worker heartbeat failed"));
          }
        })().finally(() => {
          heartbeatInFlight = undefined;
        });
      },
      Math.max(1, Math.floor(this.leaseMs / 3)),
    );

    try {
      if (!handler)
        throw new Error(`No handler registered for job kind: ${job.kind}`);
      await handler(job.payload, { job, signal: controller.signal });
      clearInterval(heartbeatTimer);
      controller.abort();
      await heartbeatInFlight;
      if (leaseLost) return { outcome: "LEASE_LOST", jobId: job.id };
      const completed = await this.queue.complete(
        job.id,
        job.lockedBy,
        leaseAt,
      );
      return { outcome: completed ? "SUCCEEDED" : "LEASE_LOST", jobId: job.id };
    } catch (error) {
      clearInterval(heartbeatTimer);
      controller.abort();
      await heartbeatInFlight;
      if (leaseLost) return { outcome: "LEASE_LOST", jobId: job.id };
      const outcome = await this.queue.fail(
        job.id,
        job.lockedBy,
        leaseAt,
        error,
      );
      return { outcome, jobId: job.id };
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let idleDelay = this.idlePollMs;
    while (!signal.aborted) {
      const result = await this.runOne();
      if (result.outcome === "IDLE") {
        await sleep(idleDelay, signal);
        idleDelay = Math.min(this.maxIdlePollMs, Math.ceil(idleDelay * 1.5));
      } else {
        idleDelay = this.idlePollMs;
      }
    }
  }
}
