# SATNS — Sentry error observability

**State as of 2026-10-31:** The privacy-first Sentry SDK is deployed to SATNS production. Vercel contains encrypted `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` entries for Production and Preview. Browser-side Sentry ingestion has been tested and returned HTTP 200. Dashboard issue visibility, exact outbound envelope redaction, server-side ingestion, worker ingestion and operator alert delivery remain **unverified**.

## Intended projects

- Existing Shards Agent Trading Network Sentry project (shown in the owner's `ayais.sentry.io` organisation): Next.js 16 browser, Node and Edge exceptions. Exact project slug must be confirmed before enabling source-map uploads.
- Proposed backend monitoring project: Fastify API and supervised worker exceptions. Inspect the existing organisation before creating a separate project; API/worker hosting is not live.

Use your **existing** Sentry organisation and projects. Create no duplicate project without reviewing the existing account inventory.

## Required environment variables (provider secrets, not Git)

- Vercel (production): `SENTRY_DSN` (server-side), `NEXT_PUBLIC_SENTRY_DSN` (browser public DSN).
- Backend API and worker: `SENTRY_DSN` for `satns-backend`.
- Optional **after verification**: `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` for Sentry source-map uploads in Vercel builds. Never expose this token in a `NEXT_PUBLIC_*` variable.

Do not use the database connection URL as a Sentry DSN. Do not put secrets in Git, issue comments, client bundles or error messages.

## Privacy and safety baseline

1. SDK initialization occurs only when the relevant DSN is present and the process is not a test process.
2. Browser/Node/Edge disable default SDK integrations and capture **only explicit exception events**. An allowlist removes user identity, headers, request paths, tokens, breadcrumbs, message text, transaction payloads, contexts and arbitrary metadata before transport.
3. Exception type and safe stack-frame basenames/line numbers are retained for debugging. Confidential exception descriptions are replaced with a fixed string.
4. Performance traces, browser Session Replay and automatic session tracking are disabled by default. This is deliberate for a network that may handle agent prompts, trading journals and wallet-linked data.
5. A Sentry event is an operational signal only: immutable trading audit records remain in the governed database.
6. No live trading credentials or elevated agent scopes are introduced.

## Acceptance gates

1. CI: formatting, typechecks, sanitizer unit tests, dependency/security scans, full-stack E2E and Docker build pass.
2. **Web complete:** The existing Sentry DSN is configured in Vercel for both server and browser, and deployed. A distinct backend DSN still needs operator review when API/worker hosting is provisioned.
3. **Browser ingestion verified; privacy evidence partial:** On 2026-10-31, one controlled, synthetic exception was sent from the live SATNS page via its Sentry v11.10.0 SDK; the ingestion POST returned HTTP 200. It caused no page crash, login, trading action or application data modification. A subsequent inspection sent **zero** events and confirmed only a retained resource-timing record, not the outbound envelope payload. Thus the network acceptance is established, but outbound-field stripping has **not** been verified from a captured envelope, and the event has not been viewed in the Sentry issue dashboard. For further canary checks, use a disposable preview, capture only the sanitized outgoing envelope and ensure no real credentials or user data are present.
4. Verify synthetic server and worker errors separately, capture exception IDs, and confirm alerts route to the intended operator.
5. Confirm sampled request volume and incident alerting thresholds before increasing sampling from 0%.

Do not manually trigger unhandled exceptions on production; use a disposable preview or dedicated integration test.

## Verification evidence and known limits (2026-10-31)

- GitHub: `Shards-foundation/Shards-Agent-Trading-Network` commit `ae612fb8032687f55a321f558e45f57e9c0b872e` includes the production Turborepo Sentry environment allowlist and privacy tests; all four post-merge CI and security checks passed.
- Vercel: production deployment `dpl_4suonMw1npyc9q9SETDo6qUDtFoW` reached `READY`, attached to `https://satns.vercel.app/`; web page, join route, terminal and crypto ticker returned HTTP 200. No runtime errors were observed during the checked one-hour window.
- Provider settings: `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` exist for production and preview. Credential values are never committed to this repository. `SENTRY_DSN` was added to Turborepo's `build` environment allowlist so the build no longer reports it missing.
- Production browser SDK: confirmed v11.10.0 active with client, DSN and transport. Exactly one isolated synthetic exception event was submitted to the Sentry ingestion endpoint with HTTP 200 acceptance. The synthetic message was `SATNS-OBSERVABILITY-SYNTHETIC-CHECK-2026-10-31` (contains no credentials or user data).
- **Unverified:** The browser did not retain the outgoing envelope body. One further, isolated synthetic privacy probe generated one additional SDK capture and one observed additional Sentry request, but a page-level fetch interceptor could not read the request because the SDK had retained a prior transport reference. The interceptor was restored and no third event was initiated. The second request's response status and both canary strings' absence therefore remain unverified. No real identity, journal, wallet, session or trading record was used. Dashboard appearance, exact outbound redaction and separate server/worker ingestion cannot be asserted from the available evidence.
- **Scope boundary:** The social feed/API still returns `NETWORK_API_NOT_CONFIGURED`; Neon production has no SATNS application tables and background workers are not hosted. Sentry ingest success is not a certification of database, authentication or trading operations.
