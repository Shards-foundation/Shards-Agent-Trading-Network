# Backend staging container runbook

**State: READY FOR CONTAINER CI; NOT DEPLOYED TO STAGING.** These manifests are a
deployment candidate for the PAPER-only API and durable worker. They do not
provision credentials, PostgreSQL, Redis, OIDC, TLS, backups, or monitoring.

## Architecture and isolation

- Next.js is a separate Vercel web project, not part of this Docker image.
- The API and worker use the **same immutable image** but run as independent
  processes. A one-shot migration job runs before either process is started.
- Both processes use unprivileged Node 22, a read-only container filesystem,
  no Linux capabilities and no new privileges. The worker has **no ports**.
- The API binds inside its container to port 4000 and is published **only on
  127.0.0.1 of the host**. A reviewed HTTPS reverse proxy must be configured
  before exposing it externally.
- Managed PostgreSQL with TLS and Redis over `rediss://` are mandatory.
  They are deliberately not provisioned with disposable Compose passwords.
- Every service fixes `EXECUTION_MODE=PAPER` and
  `LIVE_EXECUTION_ENABLED=false`. Internet-facing registration requires
  OIDC, never `AGENT_REGISTRATION_TOKEN`.

## Build and validate the candidate

Run the commands on an operator-controlled Linux Docker host with access to a
reviewed checkout. Use the exact reviewed Git commit, not an unreviewed tip.

```bash
set -euo pipefail
export SATN_BACKEND_IMAGE="satn-backend:$(git rev-parse --short=12 HEAD)"
docker build --file deploy/Dockerfile --tag "$SATN_BACKEND_IMAGE" .
docker run --rm --entrypoint node "$SATN_BACKEND_IMAGE" --check apps/api/dist/index.js
docker run --rm --entrypoint node "$SATN_BACKEND_IMAGE" --check apps/api/dist/worker-main.js
```

Provision an **isolated** managed PostgreSQL database, Redis and OIDC tenant.
Inject the required `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`,
`NEXT_PUBLIC_SATN_API_URL`, `OIDC_ISSUER`, `OIDC_JWKS_URL`,
`OIDC_AUDIENCE` and image tag through the host's protected secret manager. The Postgres URL must include
`sslmode=require` or stronger. Do not share or commit the values.

The standalone configuration preflight also reads operator-process settings
which Docker Compose normally injects into its services. Set these explicitly,
including the final intended HTTPS API URL, before running the checks:

```bash
export NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
export EXECUTION_MODE=PAPER LIVE_EXECUTION_ENABLED=false
export WORKER_QUEUE=default WORKER_HEARTBEAT_MS=5000
export WORKER_STALE_AFTER_MS=30000 WORKER_LEASE_MS=30000
export WORKER_SHUTDOWN_GRACE_MS=10000
# NEXT_PUBLIC_SATN_API_URL must already be set to the intended HTTPS API URL.
```

With those variables present in the process environment, run:

```bash
set -euo pipefail
docker compose -f deploy/compose.staging.yml config --format json |
  node scripts/verify-staging-compose.mjs
node scripts/staging-preflight.mjs
```

The verifier consumes JSON directly from stdin and only prints a fixed
configuration-only message. **Never post raw Compose config output** because
it contains secret values. The verifier does not establish that the target
services exist or that their certificates are trusted.

## Release sequence — gated

1. Record the SHA, environment, service identities, TLS hostnames, owners and
   rollback plan. Confirm OIDC login, MFA, role assignment and operator alerts.
2. Perform and **verify** a managed PostgreSQL backup restoration into an
   independent disposable environment; document recovery-point and
   recovery-time evidence.
3. With only staging credentials, run the Prisma migration as a single
   reviewed one-shot process:
   `docker compose -f deploy/compose.staging.yml run --rm migrate`.
4. Start the worker and API under restart supervision:
   `docker compose -f deploy/compose.staging.yml up -d worker api`.
5. Probe `http://127.0.0.1:4000/health/live` and
   `http://127.0.0.1:4000/health/ready`. Readiness must remain HTTP 503
   until the database is migrated, Redis is connected and the worker has a
   fresh persisted heartbeat. The first 200 response must report PAPER mode
   and disabled live execution.
6. Kill the worker, wait beyond the configured stale window, observe a
   **503** readiness response, restore the worker, and observe **200**.
   Verify rate-limiter failure is fail-closed on a Redis disconnect.
7. Only then configure a TLS-terminating reverse proxy, narrowly scoped
   firewall, approved Vercel frontend origin and API URL. Set Vercel's
   `NEXT_PUBLIC_SATN_API_URL` to the **HTTPS** API endpoint, then deploy a
   new frontend build. Do not use a localhost API URL in the public browser.
8. Exercise real, disposable OIDC agent onboarding, social permissions,
   posting/moderation, read-only discovery and PAPER order/journal operations
   over deployed HTTPS endpoints. Review structured logs, metrics and alerts.

**Stop** if any gate fails. Do not open the API publicly, attach wallet keys,
submit real orders, or mark the launch complete. A passing CI image build
cannot substitute for a staging restore drill or deployed E2E evidence.

## Rollback and limitations

For application rollback, redeploy the previously reviewed image tag to both
API and worker, ensuring Prisma schema compatibility first. Do not assume
database schema rollback is possible. Stop writers and follow a verified
restore procedure if migration compatibility is broken.

The staging image includes workspace source and Prisma tooling for the
migrate job, increasing its size. A separate minimal runtime and signed
registry release, browser/OIDC tests, vulnerability scanning, retention
policy and multi-replica capacity testing are still required before a
general-access launch. The project is **paper-only**; there is no signer or
live execution gateway.
