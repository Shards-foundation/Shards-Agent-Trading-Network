# SATNS public launch audit (read-only)

This operator-triggered job is an **independent, fail-closed prelaunch drift alarm**, **not** deployment approval. It neither deploys nor changes GitHub, Neon, Vercel, Render, identity configuration or the customer database. It uses public HTTPS probes and a short-lived GitHub Actions token with read-only permissions.

## Run

GitHub → Actions → **SATNS public prelaunch audit (read-only)** → **Run workflow** on `main`.

For local testing, use Node 22: `node --test scripts/launch-public-audit.test.mjs`; run the live probe using `node scripts/launch-public-audit.mjs`. Outputs JSON with only fixed issue codes, booleans, exact `main` SHA and audit timestamp. Never echo tokens or HTTP response bodies. Actions retains the redacted result for seven days, including when the job correctly fails on a launch blocker.

## What is actually checked

1. The public GitHub `main` branch reports `protected=true` and has a valid 40-character commit SHA. This is **not** a complete ruleset audit: required reviews, environment permissions, force-push/deletion overrides and bypass actors must be verified by an authenticated administrator in repository settings.
2. The _same commit_ has successful `validate`, `staging-container`, `Dependency vulnerability audit` and `Git history secret scan` job checks, and a successful GitHub `Vercel` commit status. Successful Vercel commit status does **not** establish which exact SHA serves production; inspect Vercel deployment ID, Git metadata and alias separately.
3. Existing prelaunch website: GET `/` and `/join` return 200; direct GET `/api/auth/login` returns 503 **without a redirect or Set-Cookie**; GET `/api/network/stats` returns 503 with `NETWORK_API_NOT_CONFIGURED`. When the backend is legitimately activated, this _prelaunch_ check must be retired/replaced by full authenticated live integration acceptance, not bypassed.

A result of `PRELAUNCH_CONTROLS_PASS` does **not** imply the product is ready, because the monitor explicitly reports `productionLaunchApproved=false`, `productionCommitAttested=false`, `neonRestoreVerified=false`, `apiWorkerOidcIntegrationVerified=false`, and `executionModeCertified=false` regardless of public HTTP status.

## Independent launch requirements

- GitHub administrator confirms required reviews/CI, protected environments and non-bypassable production controls.
- Neon snapshot successfully restored to a new disposable branch; full schema and data integrity validated; measured restore time and recovery point; backup retention and an approved ongoing backup strategy. Never overwrite an existing branch or erase a preview merely to green-light this check.
- Prisma production migrations applied using the already gated environment workflow; `_prisma_migrations` ledger, exact database identity and expected tables attested.
- API, Redis and supervised worker deployed with TLS and PAPER-only execution; worker-stale and restart tests verified against real service endpoints.
- A real OIDC provider and client validated with issuer, audience, signed ID token, PKCE/nonce and verified-email controls, plus authenticated end-to-end tests.
- The **current reviewed main SHA** deployed to Vercel production and aliased to `satns.vercel.app` with a READY build. Build quota is not evidence of application failure or release success.
- Required operator, legal, security and incident-response sign-offs before enabling human registration. No live venue trading or custody is authorised.

Manual source of truth: [release issue #64](https://github.com/Shards-foundation/Shards-Agent-Trading-Network/issues/64) and [Vercel rate-limit issue #70](https://github.com/Shards-foundation/Shards-Agent-Trading-Network/issues/70).
