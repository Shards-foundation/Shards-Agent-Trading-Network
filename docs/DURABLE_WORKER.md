# Durable Worker Queue — Foundation

**Status:** IN_PROGRESS. This change adds the PostgreSQL persistence contract only. It does not yet provide a running consumer and must not be treated as a completed job-processing system.

## Why PostgreSQL

The first queue implementation uses the existing PostgreSQL dependency instead of adding another broker. Job intent and state survive API restarts and can share transactional boundaries with domain writes. A later load test may justify a dedicated broker, but that is not assumed in the MVP.

## Persisted contract

`WorkerJob` records carry:
- a bounded queue and typed job kind;
- JSON payload (handlers must validate payloads at runtime);
- explicit lifecycle state: QUEUED, RUNNING, SUCCEEDED, RETRY_WAIT, DEAD_LETTER or CANCELLED;
- priority, availability time, attempts and maximum attempts;
- lease owner/time for crash recovery;
- optional queue-scoped idempotency key;
- bounded error summary and completion timestamp.

Indexes support polling ready jobs and finding abandoned leases. Queue consumers must claim work atomically with PostgreSQL row locks (`FOR UPDATE SKIP LOCKED`) so multiple workers cannot claim the same job concurrently.

## Required next implementation steps

1. Add a typed enqueue API with payload schemas and transaction-friendly use.
2. Implement atomic claim/lease renewal and lease-expiry recovery.
3. Add bounded retry with exponential backoff and jitter; move exhausted jobs to DEAD_LETTER.
4. Make handlers idempotent and explicitly distinguish retryable from terminal errors.
5. Add graceful shutdown, concurrency limits, heartbeat and a real worker-health probe.
6. Expose queue depth, oldest-ready-job age, retries, dead-letter counts and worker heartbeat metrics.
7. Add PostgreSQL integration tests for concurrent claims, duplicate enqueue, worker crash/reclaim, retry exhaustion and shutdown.
8. Keep trading execution out of generic jobs until a separate isolated execution gateway and its risk/permit boundary have passed review.

## Safety invariants

- A job is not acknowledged before its durable state transition commits.
- A lease timeout may cause at-least-once delivery; handlers must be idempotent. This is not exactly-once execution.
- A stale worker cannot complete a job after losing its lease; completion must verify the current lease owner/token.
- Unknown or malformed job kinds fail closed and are recorded for operator review.
- No queue payload may contain private keys, API secrets or raw authentication tokens.
- Queue health is not equivalent to worker health; readiness must require a live consumer heartbeat once the worker process exists.
