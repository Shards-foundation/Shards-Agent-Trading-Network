# Durable Worker Queue

**Status:** IMPLEMENTED LIBRARY FOUNDATION; NOT YET WIRED INTO A DEPLOYED WORKER PROCESS. The API source now contains PostgreSQL queue operations and a handler runner. Deployment health/readiness integration and live trading handlers remain out of scope.

## Architecture

The queue uses the existing PostgreSQL database rather than adding a broker. It persists job intent and state across restarts and uses row-level locking to coordinate worker replicas.

- `WorkerQueue`: enqueue, atomic claim using `FOR UPDATE SKIP LOCKED`, lease heartbeat, completion, retry/dead-letter transitions and cancellation.
- `WorkerRunner`: registered handler dispatch, lease heartbeat while handlers run, fail-closed behaviour for unknown kinds, idle backoff and abortable polling.
- `WorkerJob`: durable state, JSON payload, priority, availability, attempts, lease metadata, idempotency key, bounded error summary and completion timestamp.

## Delivery semantics

Delivery is **at least once**, not exactly once. Handlers must be idempotent. The `lockedBy` value returned by claim is a unique per-claim fencing token; pass that exact token and the current `lockedAt` timestamp to heartbeat, complete and fail. A stale lease cannot complete after a different claim takes ownership. Lease expiry and availability checks use the PostgreSQL clock to avoid cross-worker clock skew.

Enqueue idempotency is scoped to `(queue, idempotencyKey)`. Reusing a key with a different job kind or payload returns no row and fails closed. Payloads must be validated by the registered handler before side effects.

## Safety invariants

- A job is not acknowledged before its durable state transition commits.
- Exhausted retries transition to `DEAD_LETTER`; retry delay uses capped exponential backoff with jitter.
- Unknown handler kinds fail rather than being silently acknowledged.
- Never put private keys, API secrets or raw authentication tokens in queue payloads.
- Generic worker jobs must not submit live trades. Trading execution requires a separately reviewed execution gateway with risk evaluation, permit enforcement, reconciliation and kill-switch controls.
- A queue library is not proof that a worker is deployed or healthy. Production readiness requires a supervised worker process, heartbeat monitoring, queue-depth/age metrics, graceful shutdown, and integration tests against PostgreSQL.

## Remaining work

1. Wire `WorkerRunner` into a separately supervised process with controlled handler registration.
2. Add production worker health/readiness, heartbeat and queue metrics.
3. Add PostgreSQL integration tests for competing claimers, actual migration behaviour, lease expiry/reclaim, idempotency conflicts and retry exhaustion.
4. Run the complete CI suite and resolve all failures before merging.
5. Keep live trading disabled until the isolated execution/risk/permit path has passed end-to-end review.
