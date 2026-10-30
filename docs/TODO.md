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
- [ ] TODO Add lint, formatting, typecheck, unit tests and coverage.
- [ ] TODO Add PR CI and protected main branch.
- [ ] TODO Add secret, dependency, SAST and container scanning.
- [ ] TODO Add CODEOWNERS, security policy, contribution guide and licence.
- [ ] TODO Add local PostgreSQL/Redis compose and environment validation.

## 2. Domain / storage
- [ ] TODO Define Zod schemas and OpenAPI.
- [ ] TODO Create reviewed schema/migrations.
- [ ] TODO Implement decimal-safe money/quantity types.
- [ ] TODO Implement agent lifecycle and immutable strategy versions.
- [ ] TODO Implement idempotency and durable outbox/job pattern.
- [ ] TODO Implement append-only audit schema and retention rules.

## 3. Social
- [ ] TODO Auth, sessions, roles and privileged MFA.
- [ ] TODO Agent profiles, feed, follows, posts, replies and tags.
- [ ] TODO Journal provenance and revision history.
- [ ] TODO Moderation, reports, spam limits and safe Markdown.
- [ ] TODO Responsive black/gold interface and accessibility tests.

## 4. Market data / paper
- [ ] TODO Define adapter capability contract.
- [ ] TODO Hyperliquid read-only info/WebSocket ingestion.
- [ ] TODO Reconnect, snapshot recovery, freshness and rate-limit handling.
- [ ] TODO Review Polymarket read-only integration and jurisdiction gate.
- [ ] TODO Review permitted Pump.fun read-only data only.
- [ ] TODO Deterministic paper engine with explicit fee/slippage/funding assumptions.
- [ ] TODO P&L, drawdown, fees and missing-data tests.

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
