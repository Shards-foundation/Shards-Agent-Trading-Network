# SATNS — Sentry error observability

**State:** SDK-ready, dormant until the operator attaches DSNs. Sentry account/project provisioning and external alert delivery are not verified by this commit.

## Intended projects

- `satns-web`: Next.js 16 browser, Node and Edge exceptions.
- `satns-backend`: Fastify API and supervised worker exceptions.

Use your **existing** Sentry organisation and projects. Create no duplicate project without reviewing the existing account inventory.

## Required environment variables (provider secrets, not Git)

- Vercel (production): `SENTRY_DSN` (server-side), `NEXT_PUBLIC_SENTRY_DSN` (browser public DSN).
- Backend API and worker: `SENTRY_DSN` for `satns-backend`.
- Optional **after verification**: `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` for Sentry source-map uploads in Vercel builds. Never expose this token in a `NEXT_PUBLIC_*` variable.

Do not use the database connection URL as a Sentry DSN. Do not put secrets in Git, issue comments, client bundles or error messages.

## Privacy and safety baseline

1. SDK initialization occurs only when the relevant DSN is present and the process is not a test process.
2. Browser/Node/Edge capture **only exception events**. An allowlist removes user identity, headers, request paths, tokens, breadcrumbs, message text, transaction payloads, contexts and arbitrary metadata before transport.
3. Exception type and safe stack-frame basenames/line numbers are retained for debugging. Confidential exception descriptions are replaced with a fixed string.
4. Performance traces, browser Session Replay and automatic session tracking are disabled by default. This is deliberate for a network that may handle agent prompts, trading journals and wallet-linked data.
5. A Sentry event is an operational signal only: immutable trading audit records remain in the governed database.
6. No live trading credentials or elevated agent scopes are introduced.

## Acceptance gates

1. CI: formatting, typechecks, sanitizer unit tests, dependency/security scans, full-stack E2E and Docker build pass.
2. Attach the **existing** Sentry web/backend DSNs using protected provider environments and redeploy. The web project is currently not configured with any Sentry DSNs.
3. Trigger one synthetic error containing a fake canary string in a disposable preview. Verify Sentry receives a readable stack but **cannot** find the canary, URL query, authorization headers, browser session or journal text.
4. Verify synthetic server and worker errors separately, capture exception IDs, and confirm alerts route to the intended operator.
5. Confirm sampled request volume and incident alerting thresholds before increasing sampling from 0%.

Do not manually trigger unhandled exceptions on production; use a disposable preview or dedicated integration test.
