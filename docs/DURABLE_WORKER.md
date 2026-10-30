# Durable Worker Queue

**Status:** WORKER PROCESS FOUNDATION IMPLEMENTED; deployment and production handler coverage remain operator tasks. The API source contains PostgreSQL queue operations, a runner, a dedicated process entrypoint, persisted process heartbeats and API readiness checks. No live-trading handler is registered.

## Architecture

The queue uses the existing PostgreSQL database rather than adding a broker. It persists job intent and state across restarts and uses row-level locking to coordinate worker replicas.

- `WorkerQueue`: enqueue, atomic claim using `FOR UPDATE SKIP LOCKED`, lease heartbeat, completion, retry/dead-letter transitions and cancellation.
- `WorkerRunner`: registered handler dispatch, lease heartbeat while handlers run, fail-closed behaviour for unknown kinds, idle backoff and abortable polling.
- `WorkerJob`: durable state, JSON payload, priority, availability, attempts, lease metadata, idempotency key, bounded error summary and completion timestamp.
- `WorkerHeartbeat`: per-process status and last-seen timestamp; API readiness requires at least one fresh RUNNING heartbeat.
- `apps/api/src/worker-main.ts`: dedicated worker process with unique process identity, periodic heartbeat, signal-aware loop shutdown and structured lifecycle logs.
- The only built-in handler is `system.healthcheck`, a payload-validated no-side-effect handler. All other job kinds fail closed until explicitly registered.

## Local runbook

1. Apply the database migrations with `pnpm db:migrate:deploy` after setting `DATABASE_URL`.
2. Set `WORKER_QUEUE=default`, `WORKER_HEARTBEAT_MS=5000`, `WORKER_LEASE_MS=30000` and `WORKER_STALE_AFTER_MS=30000`.
3. Build the workspace with `pnpm build`.
4. Start the API and the worker as separate processes. Start the worker with `pnpm --filter @satn/api worker`.
5. Verify `GET /health/ready` reports `dependencies.worker: "connected"`. Stop the worker and verify readiness becomes degraded after its heartbeat is no longer fresh.

The process manager (container orchestrator, systemd or equivalent) must restart non-zero exits. Do not run the worker inside the API process: they have independent lifecycles and resource limits.

## Delivery semantics

Delivery is **at least once**, not exactly once. Handlers must be idempotent. The `lockedBy` value returned by claim is a unique per-claim fencing token; pass that exact token and the current `lockedAt` timestamp to heartbeat, complete and fail. A stale lease cannot complete after a different claim takes ownership. Lease expiry and availability checks use the PostgreSQL clock to avoid cross-worker clock skew.

Enqueue idempotency is scoped to `(queue, idempotencyKey)`. Reusing a key with a different job kind or payload returns no row and fails closed. Payloads must be validated by the registered handler before side effects.

## Safety invariants

- A job is not acknowledged before its durable state transition commits.
- Exhausted retries transition to `DEAD_LETTER`; retry delay uses capped exponential backoff with jitter.
- Unknown handler kinds fail rather than being silently acknowledged.
- Never put private keys, API secrets or raw authentication tokens in queue payloads.
- Generic worker jobs must not submit live trades. Trading execution requires a separately reviewed execution gateway with risk evaluation, permit enforcement, reconciliation and kill-switch controls.
- A queue library is not proof that a worker is deployed or healthy. Production readiness additionally requires a process supervisor, queue-depth/age metrics, alerting, and deployment-level restart tests. The worker writes its own heartbeat; the API marks readiness degraded if no heartbeat is fresh.

## Remaining work

1. Deploy the worker as a separately supervised service and configure restart policy, resource limits and log shipping.
2. Add queue-depth/oldest-job metrics and alerts; a fresh heartbeat alone does not prove useful jobs are completing.
3. Add deployment-level restart, stale-heartbeat and lease-expiry/reclaim tests.
4. Add a transactional outbox or document and test transaction-bound enqueue for domain writes that must atomically schedule work.
5. Keep live trading disabled until the isolated execution/risk/permit path has passed end-to-end review.
