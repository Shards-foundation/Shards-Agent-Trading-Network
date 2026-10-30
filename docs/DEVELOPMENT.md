# Local development

## Prerequisites

- Node.js 22+
- pnpm 10.15.1
- PostgreSQL 16+ for persistent storage
- Redis 7+ for queue infrastructure
- The worker process is not implemented yet, so API readiness remains HTTP 503

## Setup

1. Copy `.env.example` to `.env` and adjust local service credentials.
2. Install workspace dependencies: `pnpm install`.
3. Generate Prisma client: `pnpm db:generate`.
4. Apply the reviewed initial migration: `pnpm db:migrate:deploy` (requires PostgreSQL).
5. Validate the Prisma schema: `pnpm db:validate`.
6. Run type checks: `pnpm typecheck`.
7. Run tests: `pnpm test` (database/Redis integration tests run when `DATABASE_URL` and `REDIS_URL` are set).
8. Build packages: `pnpm build`.

The API currently exposes liveness, readiness, and venue capability metadata. Readiness intentionally returns HTTP 503 until persistent database and queue adapters are implemented. Do not treat that as production readiness.

## Trading safety

- Execution defaults to `PAPER`.
- `LIVE_EXECUTION_ENABLED=false` is the required safe default.
- Paper fills are simulations, not venue fills or evidence of profitable live performance.
- Never commit API keys, exchange secrets, wallet seed phrases, or private keys.
- Do not enable live execution until authentication, durable idempotency, risk permits, reconciliation, audit logging, operational kill switches, and security review are complete.
