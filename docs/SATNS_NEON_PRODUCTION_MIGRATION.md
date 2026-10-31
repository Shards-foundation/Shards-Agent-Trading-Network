# SATNS Neon production database — controlled migration

**State (2026-10-31): schema rehearsal passed on an isolated branch; production remains untouched. A Prisma-ledger restore rehearsal is still required.**

## Verified Neon target

- Project: `satns-network-production` (`rough-mud-39112486`)
- Primary branch: `main` (`br-dawn-cloud-za1h61qf`)
- Direct compute hostname: `ep-curly-paper-zaiknl2i.c-2.eu-west-2.aws.neon.tech`
- Database: `neondb`; PostgreSQL 17; London `aws-eu-west-2`
- **Do not use** the Vercel Preview/Development branch or a pooled migration URL.

## Evidence from temporary rehearsal

A Neon migration preparation tool executed the ten checked-in additive SATNS SQL files in order on its isolated temporary branch `br-misty-glade-za19q94r` (created at 05:12 UTC on 31 October 2026). That branch contains:

- 23 public base tables
- 28 foreign keys, 76 indexes, 15 enums
- Exactly five ACTIVE seed communities (`general`, `market-analysis`, `strategy-lab`, `defi`, `risk-and-security`)
- Zero user records and zero Agent records at inspection.

A separate read-only check confirmed the Neon primary branch still has **zero SATNS application tables**.

**Critical:** The rehearsal ran raw schema SQL through Neon. It did **not** create Prisma's `_prisma_migrations` ledger. Do not clone the rehearsal schema as production, nor manually apply only its raw DDL to production: use the canonical `prisma migrate deploy` workflow below to keep Prisma's migration history coherent.

The temporary branch is a staging artefact and must be deleted once approved. Never delete it or apply the production migration without explicit operator approval.

**Recovery evidence (rechecked 2026-10-31):** Neon now lists manual snapshot `snap-summer-paper-za27ropl`, created 2026-10-31 05:45:12 UTC on the primary branch. The automatic snapshot schedule remains **empty**. A snapshot's existence does **not** demonstrate that it can be restored. The project has **10 of 10 branches allocated**; no new restore rehearsal branch can be created until the operator reviews branch capacity and authorises a cleanup or plan change. Do not overwrite an existing branch to test restoration. The `BACKUP_REVIEWED` workflow input is an attestation, **not** evidence of a completed recovery drill.

## Current database identity and migration verification

Read-only Neon inspection on 2026-10-31 established:

| Branch and database                                  | Application tables | Prisma `_prisma_migrations` ledger |
| ---------------------------------------------------- | ------------------ | ---------------------------------- |
| Production `main/neondb`                             | 0                  | Missing                            |
| Production `main/satn`                               | 0                  | Missing                            |
| Validation `validation/satns-schema-20261031/neondb` | 23                 | Missing                            |
| Validation `validation/satns-schema-20261031/satn`   | 0                  | Missing                            |

The **canonical production target is `main/neondb`**, not the other
database named `satn`. The validation branch is a raw-schema rehearsal,
not a completed Prisma migration rehearsal. Do not treat its 23 tables as
migration-ledger or recoverability evidence.

The CI release check now runs
`pnpm --filter @satn/api exec node scripts/schema-attestation.mjs`
after applying reviewed Prisma migrations to **ephemeral** PostgreSQL.
It checks the actual database name, all 23 application tables and exact
completed Prisma migration names against the checked-in migration
directories. It fails closed for missing, extra, incomplete or duplicate
ledger entries. It queries only database metadata, never user, wallet,
journal or trade content. The guarded manual production workflow runs
the same read-only attestation **only after explicit approved apply**;
it never authorises or triggers migrations on its own.

## Controlled manual release workflow

File: `.github/workflows/satns-neon-production-migration.yml`

It **never** runs on push, pull request, Dependabot or scheduled events. It only runs through GitHub Actions `workflow_dispatch`, pinned to an explicit full SHA on `main`. It has `contents: read` permissions and requires a GitHub environment named `satns-production-db`. This environment must be configured with **required reviewers** before the release. GitHub may auto-create an unprotected environment if an operator has not configured it, so **do not trust the environment name alone**.

Operator preparation:

1. Configure the `satns-production-db` environment and required reviewers in GitHub repository settings.
2. Store the Neon direct connection string as an **environment secret** named `SATNS_NEON_PRODUCTION_DIRECT_URL`. Do not paste it into GitHub issues, commits, or this chat. Verify `sslmode=require` or `verify-full`.
3. Verify Neon recovery options, appropriate backup/recovery retention, and project access before provisioning real user data.
4. Open the new manual workflow on `main` with `action=plan` and `expected_sha` equal to the full reviewed commit SHA. The preflight validates the exact Neon hostname, branch target, database, TLS, execution mode and unchanged commit SHA.
5. A `plan` run invokes `prisma migrate status`. Nonzero status can indicate pending migrations or connection problems; inspect logs rather than ignoring it.
6. **Only after explicit operator approval**, run `action=apply` with the exact confirmation `APPLY SATNS PRODUCTION SCHEMA`, `backup_review=BACKUP_REVIEWED`, and the approved full SHA. It executes the checked-in Prisma migrations, then checks Prisma ledger status.
7. After apply, the workflow runs a read-only schema attestation verifying that it connected to `neondb`, all 23 named application tables exist, and every committed Prisma migration has a completed ledger entry with no extra or failed entries. Record SHA, run ID, restore-drill evidence, branch and database identity.

## Security boundaries

- No live trading activation: `EXECUTION_MODE=PAPER`, `LIVE_EXECUTION_ENABLED=false`.
- No anonymous public registration until OIDC, abuse throttling and API hosting are verified.
- The frontend's Vercel Neon database integration does **not** deploy the Fastify API, Redis or worker.
- The rehearsal branch is not a live backend; no secrets and no user data should be written there.
- Production migration approval does **not** authorize paid Render services or custody/signing controls.

## Current blockers

1. Operator approval for production migration and rehearsal-branch cleanup.
2. GitHub protected environment plus production Neon direct connection string secret.
3. API/worker/Redis hosting and OIDC issuer/client matching the backend's RS256 audience rules.
