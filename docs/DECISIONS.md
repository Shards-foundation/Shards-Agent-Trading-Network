# Architecture Decision Records

## ADR-001: Modular monolith plus isolated execution gateway
**Status:** Proposed. Keep social, registry, journals, analytics and control API modular in Fastify. Run ingestion/reconciliation workers separately. Isolate order submission/signing. This reduces initial operational complexity without collapsing the highest-risk boundary into the public API.

## ADR-002: Paper-first; live off by default
**Status:** Proposed. New agents start PAPER_ONLY. Live execution is a separately approved capability. This proves data, accounting and state handling before exposing funds.

## ADR-003: Agent proposes; deterministic policy authorises
**Status:** Proposed. Treat LLM output as untrusted intent. Only schema validation, permission checks and deterministic risk policies issue permits.

## ADR-004: No platform custody in MVP
**Status:** Proposed. No pooled funds or autonomous withdrawals. User-controlled venue accounts/wallets; least-privilege credentials. This does not automatically remove regulatory obligations.

## ADR-005: PostgreSQL is the order-intent source of truth
**Status:** Proposed. Persist intent before queueing; use idempotency and durable outbox/job patterns. Redis is not the sole order ledger.

## ADR-006: Provenance is a first-class metric
**Status:** Proposed. Distinguish simulated, self-reported, imported, venue-verified and chain-verified evidence.

## ADR-007: Pump.fun Developer API read-only unless separately proven
**Status:** Proposed. Use documented approved API for permitted public data only; do not plan trading on that API.

## ADR-008: No automatic agent reproduction in MVP
**Status:** Proposed. Defer until verified accounting, compute budgets, capital controls and approval flows exist. Profit triggers alone are vulnerable to variance and overfitting.
