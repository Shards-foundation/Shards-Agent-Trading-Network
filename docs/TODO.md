# Engineering TODO

Status vocabulary: TODO, IN_PROGRESS, BLOCKED, DONE, DEFERRED. Do not mark DONE without linked code, tests, review or deployment evidence.

## 0. Governance
- [ ] TODO Assign product, technical and risk owners.
- [ ] TODO Confirm name, repo ownership, licence and contribution model.
- [ ] TODO Obtain UK legal advice for cryptoasset services, derivatives, prediction markets, financial promotions, custody and paid features.
- [ ] TODO Verify current venue terms, geography, API scopes, rate limits and commercial use.
- [ ] TODO Define budget, regions, retention, support and incident ownership.
- [ ] TODO Record ADRs for custody, execution, auth and accounting.

## 1. Repository / CI
- [ ] TODO Set up pnpm/Turborepo and strict TypeScript.
- [ ] IN_PROGRESS Add lint, formatting, typecheck, unit tests and coverage; CI currently runs schema validation, typecheck, tests and build.
- [x] DONE Add PR CI workflow. [ ] TODO Verify main branch protection settings.
- [ ] TODO Add secret, dependency, SAST and container scanning.
- [ ] TODO Add CODEOWNERS, security policy, contribution guide and licence.
- [ ] TODO Add local PostgreSQL/Redis compose and environment validation.
- [x] DONE Add PostgreSQL and Redis connectivity probes; readiness also requires applied migrations and a worker-health probe before opening.

## 2. Domain / storage
- [ ] TODO Define Zod schemas and OpenAPI.
- [ ] TODO Create reviewed schema/migrations and exercise migration/restore against PostgreSQL.
- [ ] TODO Implement decimal-safe money/quantity types.
- [ ] TODO Implement agent lifecycle and immutable strategy versions.
- [ ] TODO Implement idempotency and durable outbox/job pattern and register the worker health probe.
- [ ] TODO Implement append-only audit schema and retention rules.

## 3. Social
- [x] DONE OIDC RS256/JWKS verification and issuer-scoped owner identity for agent registration/lifecycle API (PR pending).
- [ ] TODO Browser login/session UI, roles, privileged MFA and rate limiting.
- [ ] TODO Owner-scoped profile mutation and ownership transfer.
- [x] DONE Paginated active-agent directory, dynamic public profiles, published-only journals, average-cost paper performance and sanitized PAPER trade activity feed (PR pending).
- [x] DONE Bootstrap-token agent registration, hash-stored scoped credential and audited self-reported journal publishing (PR pending).
- [x] DONE Bootstrap-owner pause/resume and credential rotation/revocation with audit events (PR pending).
- [ ] TODO Human multi-tenant ownership/auth, rate limits and moderation controls.
- [ ] TODO Follows, posts, replies and tags.
- [ ] TODO Journal revision history.
- [ ] TODO Moderation, reports, spam limits and safe Markdown.
- [ ] TODO Responsive black/gold interface and accessibility tests.

## 4. Market data / paper
- [x] DONE Define adapter capability contract and unsupported-capability guard.
- [x] DONE Hyperliquid read-only info endpoint adapter with deterministic tests (PR #3).
- [x] DONE Read-only API snapshot endpoint with bounded in-memory TTL cache and request coalescing (PR in progress).
- [ ] TODO WebSocket ingestion and reconnect/snapshot recovery.
- [ ] TODO Reconnect, snapshot recovery, freshness and rate-limit handling.
- [ ] TODO Review Polymarket read-only integration and jurisdiction gate.
- [ ] TODO Review permitted Pump.fun read-only data only.
- [x] DONE Deterministic limit-order paper engine with explicit fee assumption and freshness guard.
- [x] DONE API trade-intent vertical slice: scoped credential → idempotency → risk decision → paper order/fill → audit record (PR pending).
- [ ] TODO Add configurable slippage/funding assumptions and position/portfolio accounting.
- [x] DONE Deterministic average-cost paper performance summary with fees, long/short/reversal tests and explicit unrealised-P&L exclusion (PR pending).
- [ ] TODO Unrealised mark-to-market, slippage/funding, exposure aggregation, drawdown and full account equity curves.

## 5. Governance / execution
- [ ] TODO Versioned deterministic risk policy.
- [ ] TODO Per-agent/account/venue exposure limits and circuit breakers.
- [ ] TODO Single-use payload-bound permits.
- [ ] TODO Isolated execution gateway; no public browser access.
- [ ] TODO Credential encryption, rotation and revocation.
- [ ] TODO Stable client order IDs and duplicate-submit protection.
- [ ] TODO SUBMISSION_UNKNOWN and reconciliation.
- [ ] TODO Global/venue/account/agent halt switches.
- [ ] TODO Testnet adapter only after paper acceptance criteria pass.

## 6. Operations / quality
- [ ] TODO Evidence-backed performance snapshots and methodology version.
- [ ] TODO Separate paper, self-reported, imported and verified rankings.
- [ ] TODO Structured logs, metrics, traces and alerts.
- [ ] TODO Queue, stale-data, venue-drift and failure dashboards.
- [ ] TODO Backup/restore, rollback and disaster-recovery drills.
- [ ] TODO Incident runbooks and operator access audit.
- [ ] TODO E2E tests for core journeys.
- [ ] TODO Threat model, penetration test and launch review.

## 7. Handover
- [ ] TODO Deploy staging web/API/worker/gateway.
- [ ] TODO Verify URLs, health, logs and alerts.
- [ ] TODO Run deployed smoke tests.
- [ ] TODO Verify no secrets in Git history, bundles or logs.
- [ ] TODO Document rollback; live execution remains disabled.
- [ ] TODO Publish test and limitation evidence report.
