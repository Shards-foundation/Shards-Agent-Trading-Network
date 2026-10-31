# Verification strategy and release test gates

**Status:** Test infrastructure exists in source control. A check passing in CI establishes only that the specific test ran in its disposable environment. It is **not** evidence of public staging deployment, regulatory approval, browser compatibility or live-trading safety.

## Test portfolio and purpose

| Layer                          | Source / command                                                                               | Failure boundary covered                                                                                                              | Required in PR CI                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Deterministic unit             | `pnpm test` in packages                                                                        | Risk thresholds, precision, paper-fill assumptions, accounting, authentication and adapter contracts                                  | Yes                                                                   |
| Adversarial / property         | `packages/risk/test/adversarial.test.ts`                                                       | Reproducible seeded exact-product checks, decimal exhaustion, non-paper denial                                                        | Yes                                                                   |
| Metamorphic accounting         | `packages/accounting/test/invariants.test.ts`                                                  | Long/short round-trips, zero residual position, UTC loss, instrument isolation                                                        | Yes                                                                   |
| Database and Redis integration | Existing `apps/api/src/*.integration.test.ts`; `pnpm test` with `DATABASE_URL` and `REDIS_URL` | Real migrations, scoped writes, idempotency, serialised paper risk, lease recovery, stale credentials                                 | Yes                                                                   |
| Compiled runtime smoke         | `apps/api/scripts/worker-lifecycle-smoke.mjs`                                                  | Built artefacts, readiness, worker processing, termination, heartbeat expiry, replay fencing                                          | Yes                                                                   |
| Full-stack HTTP E2E            | `scripts/fullstack-e2e.mjs`                                                                    | Real API registration, persisted private/public journals, Next.js SSR, XSS escaping, paused-agent visibility and credential rejection | Yes                                                                   |
| Preflight negative tests       | `node --test scripts/staging-preflight.test.mjs`                                               | TLS/OIDC/service configuration fail-closed behaviour                                                                                  | Yes                                                                   |
| Secret / dependency audit      | `.github/workflows/security.yml`                                                               | Known dependency vulnerabilities and committed credentials                                                                            | Yes                                                                   |
| Browser interaction E2E        | Chromium CDP (`scripts/browser-smoke.mjs`, called by `fullstack-e2e.mjs`)                      | Hydrated React, fail-closed feed, retry button, community form, disabled registration and mobile viewport                             | **Yes**; unauthenticated browser smoke only                           |
| Recovery / load / chaos        | Staging deployment and monitored exercises                                                     | Backup restore, migrations rollback, supervised restarts, resource saturation, backpressure                                           | **Not yet executed**; required before public or funded service launch |
| Testnet / live execution       | Dedicated gateway-specific acceptance suite                                                    | Signature custody, permits, venue reconciliation, duplicate fills, halts                                                              | **Blocked**; no approved signer or live-trading gateway exists        |

## Required CI sequence

1. Frozen lockfile dependency install; generate and validate Prisma schema.
2. Apply every migration to disposable PostgreSQL 16.
3. Typecheck and Prettier of changed files; Prisma formatter gate.
4. Unit, integration, deterministic adversarial and metamorphic tests.
5. Build; assert that API and worker executable artefacts exist.
6. Start real API and worker, verify lease fencing and lifecycle recovery.
7. Start a real Next.js production server and API, exercise persisted agent/journal read/write over HTTP, and launch headless Chromium against that disposable instance to test React hydration, feed error/retry, a sign-in-gated community form, unavailable registration and mobile rendering.
8. Run staging preflight negative tests; independently pass security workflow.
9. Require all checks to pass **on the exact PR head SHA** before merge. Recheck main after merge.

The CI job is deliberately serial for migrations, process tests and E2E: concurrent test jobs writing to the same ephemeral database could create misleading results. All fixtures use random identifiers and cleanup. No live venue writes are permitted.

## Explicit limitations

- The full-stack HTTP E2E now includes **real headless Chromium interactions** through Node 22 native Chrome DevTools Protocol and the installed CI browser; this is not merely SSR. The browser smoke uses a production-built Next.js server with an intentionally unconfigured external HTTPS social upstream, so it proves fail-closed UI, mobile rendering and unauthenticated control behaviour. It does **not** test authenticated voting, user registration, a live browser-to-API social write, broad accessibility or multiple browser engines. Those still require a configured OIDC test tenant and separate staging acceptance.
- Seeded property checks cover sampled boundaries. They do not constitute a formal proof, exhaustive verification or a third-party property-testing framework.
- Simulated order results do not establish exchange fills, exchange terms eligibility or financial profitability.
- CI uses synthetic bootstrap credentials and disposable storage. Internet-facing staging must use OIDC, TLS and independent restricted operator access. The synthetic bootstrap test is never a production onboarding recommendation.
- Operational tests remain blocked until a separately supervised staging API and worker with backups/monitoring have been deployed.

## Release gating decisions

For a paper-only internal demonstration, unit/integration, worker smoke, full-stack SSR and security workflows are mandatory. Before opening the site publicly, add real-browser E2E, vulnerability management, identity/role testing, accessibility, backups/restore and load/restart drills. Before any testnet order, add execution gateway, durable single-use permits, key isolation, independent reconciliation, incident drills, legal and venue review. Live funds remain excluded.
