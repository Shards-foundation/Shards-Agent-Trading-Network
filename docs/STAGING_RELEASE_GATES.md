# Staging Deployment: Release Gates and Verification

**Status:** Configuration preflight and CI tests exist. No staging deployment, operator sign-off, external health evidence or live trading is asserted by this document.

## Execution boundary

The intended topology is an HTTPS Next.js web frontend, a separate Fastify API, a dedicated PostgreSQL-backed worker, PostgreSQL and Redis. An isolated execution gateway/signer does **not** exist and must not be deployed or simulated as functional. `EXECUTION_MODE=PAPER` and `LIVE_EXECUTION_ENABLED=false` are required in all staging processes. Agent registration uses OIDC, not a shared public bootstrap token.

Do not expose the API until access controls, secrets and network restrictions have been checked. The staging environment is for test data only; never reuse mainnet credentials or real wallet keys.

## 1. Configuration-only preflight

Set the following through the deployment platform's secret manager, never by committing a populated `.env` file. Use actual managed-service addresses and least-privilege accounts.

- **API:** `NODE_ENV=production`, `API_HOST=0.0.0.0`, and `API_PORT` matching the service's listening port.
- **Execution:** `EXECUTION_MODE=PAPER`, `LIVE_EXECUTION_ENABLED=false`.
- **Frontend:** `WEB_ORIGIN=https://...` and `NEXT_PUBLIC_SATN_API_URL=https://...`.
- **Identity:** `OIDC_ISSUER`, `OIDC_JWKS_URL` with HTTPS, plus a non-empty `OIDC_AUDIENCE`.
- **Bootstrap fallback:** `AGENT_REGISTRATION_TOKEN` must be absent in internet-facing staging.
- **Storage:** `DATABASE_URL` with PostgreSQL TLS (`sslmode=require` or stricter) and `REDIS_URL` using `rediss://`.
- **Worker:** `WORKER_QUEUE`, `WORKER_HEARTBEAT_MS`, `WORKER_STALE_AFTER_MS`, `WORKER_LEASE_MS`, and `WORKER_SHUTDOWN_GRACE_MS`.
- **Timing:** Heartbeat shorter than stale threshold; shutdown grace shorter than half the lease.

Before deploying a candidate, run `node scripts/staging-preflight.mjs` with its real staging environment variables loaded in the process environment. It emits only fixed issue codes and an explicit `operationalVerification: "NOT_PERFORMED"` flag. A successful exit confirms **configuration shape only**, not operational readiness, security posture or legal eligibility. The preflight is tested in CI against synthetic, intentionally non-operational examples.

Do **not** paste decrypted environment variables, private DSNs or credentials into GitHub comments or ChatGPT.

## 2. Database and worker rollout

1. Check the target region, trusted network path, TLS and independent credentials for the API/worker.
2. Back up the staging PostgreSQL instance and verify an actual restore into a disposable instance. Record recovery-point/recovery-time evidence externally.
3. Apply reviewed Prisma migrations with `pnpm db:migrate:deploy` using a one-shot release job, not concurrent API replicas.
4. Start the dedicated worker as a separately supervised process: `pnpm --filter @satn/api worker`. Configure restart policies, CPU/memory limits and shipping of redacted structured logs.
5. Start the API separately using `pnpm --filter @satn/api start`; expose it via a TLS reverse proxy only after the readiness gate passes.
6. Configure the Next.js frontend using the correct public API URL and bounded API CORS origin.

Never use `docker-compose.yml` development credentials outside the isolated local/test environment. The production-grade service manifests, secret distribution and operational monitoring remain deployment-specific work.

## 3. Measured acceptance evidence

Capture the exact Git SHA, environment name, deployed URLs, CI run, migration result and UTC timestamps. Execute the following checks against the deployed **staging** services:

- `GET /health/live` returns HTTP 200 even when external dependencies are unavailable; this is liveness, not authorization to serve traffic.
- `GET /health/ready` returns HTTP 200 **only** when database migration probe, Redis and fresh worker heartbeat succeed; assert PAPER and `liveEnabled: false`.
- Stop or kill the worker and verify readiness becomes HTTP 503 after the stale window. Restart it and verify it returns HTTP 200.
- Exercise OIDC-authenticated agent registration, scoped agent actions, social posting/reporting/moderation, read-only market discovery and the deterministic PAPER trading path with disposable test agents and fixture-backed evidence.
- Confirm rate limiting fails closed when Redis fails; the API must not accept writes based on an in-memory fallback when `NODE_ENV=production`.
- Inspect redacted logs, alert delivery, backups/restores, operator access records and the documented rollback procedure. Preserve negative-test evidence.
- Verify the frontend never displays live fills as simulated proof or claims market verification without corresponding provenance.

**Hard stop:** no public staging exposure until real OIDC tenant/roles/MFA and operator/incident contacts are established. Do not infer those controls from an OIDC issuer URL alone.

## 4. Rollback and sign-off

Rollback must cover the web/API/worker version **and** database schema compatibility. Avoid destructive down migrations; if schema rollback is unsafe, restore from a verified backup and stop affected writers. Provide an audited incident timeline, names of responsible approvers, unresolved risks and a signed release decision.

Testnet/mainnet execution remains a **separate phase** requiring supported venue test credentials, jurisdiction/eligibility review, isolated signer, single-use durable permit enforcement, reconciliation, halt drills and security sign-off. No operator can opt out of those controls by setting `LIVE_EXECUTION_ENABLED=true` in this codebase.
