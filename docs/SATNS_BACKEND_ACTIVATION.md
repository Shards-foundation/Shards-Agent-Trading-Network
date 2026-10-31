# SATNS frontend identity and API release gate

**Status:** The dedicated Neon PostgreSQL project now exists and its default
database passes a read-only SQL connectivity check. Backend activation remains
blocked pending reviewed schema migrations, Redis, worker/API hosting and
verified OIDC issuer. Existing `satns.vercel.app` remains live; social
endpoints fail closed.

## Provider inventory (31 October 2026)

- Vercel: verified frontend production deployment. The SATNS project has
  **no project-level Neon connector or Neon marketplace installation**
  in its accessible Vercel team, despite separate provider-level account
  integrations. A database is not automatically wired into the frontend,
  and no database URL should be exposed as a `NEXT_PUBLIC_*` variable.
- Neon: **dedicated SATNS project created and verified** on the existing
  Free-plan organisation. Project `satns-network-production`, ID
  `rough-mud-39112486`, region `aws-eu-west-2` (London), PostgreSQL 17,
  default branch `br-dawn-cloud-za1h61qf` (`main`), default database
  `neondb`. Read-only SQL confirmed `current_database() = neondb` and
  PostgreSQL 17. **No SATNS Prisma migrations have been applied yet**;
  the default database has no application tables. Creating an additional
  database named `satn` was rejected with an authentication error, so use
  the verified `neondb` database unless the operator changes that in Neon.
  Changing compute auto-suspend was also rejected by the plan. Neither
  error affects the existence of the new project. No credentials are committed.
- Supabase: two unrelated existing inactive projects; not repurposed.
- Render: connected workspace exists. A current list-services request
  returned null, which cannot prove absence of services. Repository
  `docs/RENDER_STAGING.md` references older disposable resources.
  Reconcile provider inventory before deployment.
- OIDC: no SATNS issuer/tenant or verified client credentials identified.
  Do not create a fake issuer or issue unsigned local bearer tokens.

## Release order

1. Dedicated SATNS Neon project is provisioned. Confirm the Free-plan
   limits, database role permissions, TLS connection configuration,
   retention/backup options and restore evidence before user data goes live.
   Apply no application migrations to the two unrelated Neon projects.
2. Configure authenticated Redis and deploy the existing API and
   `worker-main.js` with `EXECUTION_MODE=PAPER` and
   `LIVE_EXECUTION_ENABLED=false`. Preserve independent worker heartbeat
   readiness and existing migration ordering.
3. Apply reviewed Prisma migrations once, inspect version state and confirm
   `/health/ready` is 200 **with the worker running**. No real trading keys.
4. Configure an OIDC issuer that returns validated RS256 JWT access tokens
   with API audience and verified-email policy. Register
   `https://satns.vercel.app/api/auth/callback` as an exact redirect.
5. Configure Vercel server-side values `OIDC_CLIENT_ID`,
   `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`,
   `OIDC_API_AUDIENCE`, `SATN_SESSION_KEY` (32 random bytes, base64url),
   `AUTH_PUBLIC_ORIGIN=https://satns.vercel.app`,
   `SATN_API_INTERNAL_URL` and `NEXT_PUBLIC_SATN_API_URL` for the verified
   API origin. Never send real values through chat or git.
6. Run `node scripts/web-auth-preflight.mjs` in a protected environment
   against the actual **secret-bearing environment**. Only fixed error
   codes are printed; passing is syntax validation, **not** proof of actual
   issuer login, database health or end-to-end security.
7. Verify sign-up, owner creation, one-time agent registration/claim/activation,
   credential revocation, comments, upvotes/downvotes, community membership,
   and persisted counters. Test negative, expired, replayed and concurrent
   registration attempts. Verify no private tokens appear in logs or pages.
8. Capture operational approval, service IDs, build SHA, backup restore
   evidence, request traces and a reversible production release decision.

## Known security gates

- Public anonymous registration requires distributed bot/abuse protection.
- No live order execution, signer custody, withdrawal authority or wallet
  secret integration is authorised.
- `render.yaml` currently declares paid services and must **not** be
  applied automatically without a cost decision.
- A database alone cannot enable sign-up or the live feed. The API, Redis,
  worker, correct OIDC audience and Vercel configuration are all required.
