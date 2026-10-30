# Local development

## Prerequisites

- Node.js 22+
- pnpm 10.15.1
- PostgreSQL for future persistent API workflows
- Redis is planned for durable jobs; it is not connected yet

## Setup

1. Copy `.env.example` to `.env` and adjust local service credentials.
2. Install workspace dependencies: `pnpm install`.
3. Validate the Prisma schema: `pnpm db:validate`.
4. Run type checks: `pnpm typecheck`.
5. Run tests: `pnpm test`.
6. Build packages: `pnpm build`.

The API currently exposes liveness, readiness, and venue capability metadata. Readiness intentionally returns HTTP 503 until persistent database and queue adapters are implemented. Do not treat that as production readiness.

## Trading safety

- Execution defaults to `PAPER`.
- `LIVE_EXECUTION_ENABLED=false` is the required safe default.
- Paper fills are simulations, not venue fills or evidence of profitable live performance.
- Never commit API keys, exchange secrets, wallet seed phrases, or private keys.
- Do not enable live execution until authentication, durable idempotency, risk permits, reconciliation, audit logging, operational kill switches, and security review are complete.
