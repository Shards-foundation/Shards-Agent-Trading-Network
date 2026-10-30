# Local development and pre-release verification

## Prerequisites

- Node.js 22+
- pnpm 10.15.1
- PostgreSQL 16+ and Redis 7+
- Independent API and worker processes (the worker is implemented; no live venue handlers are registered)

## Setup

1. Start isolated PostgreSQL and Redis instances using `docker compose up -d`. The default Compose credentials are disposable development values, not deployable secrets.
2. Configure `DATABASE_URL` and `REDIS_URL` from `.env.example`, using private development credentials.
3. `pnpm install --frozen-lockfile`
4. `pnpm db:generate`
5. `pnpm db:migrate:deploy`
6. `pnpm db:validate`
7. `pnpm typecheck`
8. `pnpm test` (PostgreSQL/Redis integration tests run when both URLs are present)
9. `pnpm build`
10. Start the API with `pnpm --filter @satn/api start` and, separately, the durable worker with `pnpm --filter @satn/api worker`.

The API exposes `GET /health/live` and `GET /health/ready`. Readiness is **fail-closed** until PostgreSQL migrations, Redis and a fresh RUNNING worker heartbeat are all verified. An HTTP 200 liveness response alone does not prove readiness.

## Built-process release smoke

Against an **isolated and migrated** PostgreSQL/Redis test environment, run:

```bash
NODE_ENV=production EXECUTION_MODE=PAPER LIVE_EXECUTION_ENABLED=false \
  pnpm --filter @satn/api exec node scripts/worker-lifecycle-smoke.mjs
```

The script runs the built API HTTP listener and real worker subprocesses. It checks readiness before startup, a durable healthcheck job, graceful SIGTERM, worker restart, forced SIGKILL and stale heartbeat rejection, reclaimed expired leases, and the rejection of stale acknowledgements. It uses an ephemeral queue name and cleans up its test rows. The GitHub CI workflow runs this smoke test after `pnpm build`, with disposable PostgreSQL and Redis service containers.

Do not run this script against production databases: it deliberately terminates spawned workers and creates test jobs. CI passing is evidence of **test-environment behaviour**, not proof of a deployed runtime, process supervision, or disaster recovery.

## Deployment gates

Before exposing an internet-facing staging environment, separately verify TLS, non-public database/Redis access, bounded CORS, real OIDC identities and role assignment, secret injection, worker process supervision, backups and a restore drill, migration rollback, metrics/alerts, and externally reachable readiness. The bootstrap registration token must not be exposed to browsers or public traffic.

## Trading safety

- `EXECUTION_MODE=PAPER` and `LIVE_EXECUTION_ENABLED=false` remain enforced.
- Simulated fills are not venue fills or evidence of profitable live performance.
- No private keys, wallet seed phrases, live venue credentials or withdrawals belong in browser code, repo files or queue payloads.
- Do not enable testnet/live execution without separate permit-bound gateway, signer isolation, idempotency, reconciliation, kill switches, threat review and legal/venue eligibility gates.
