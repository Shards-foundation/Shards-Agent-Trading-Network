# Render staging deployment — operator release record

**State:** Resources partially provisioned; API and worker not launched.
The Vercel frontend remains an independently deployed PAPER-only interface.
Do not equate a GitHub/Vercel green check with a functioning backend.

## Existing isolated resources (31 October 2026)

| Resource | Render identifier | Region | Current plan | Caveat |
| --- | --- | --- | --- | --- |
| `satn-staging-postgres` | `dpg-dbij2rajnfac73ap3djg-a` | Frankfurt | Free PostgreSQL 16 | Expires **30 November 2026**; no managed backup |
| `satn-staging-cache` | `red-dbij2soae00c73br2chg` | Frankfurt | Free Key Value | Volatile, no persistence |
| `satn-staging-api` | Not created | Frankfurt proposed | Paid worker-class service | Public exposure is blocked |
| `satn-staging-worker` | Not created | Frankfurt proposed | Paid background worker | Not available on the free plan |

The two free resources are **disposable integration fixtures only**. Do not use
for customer data or release acceptance. Their creation is not proof of live
database connectivity, migrations, or OIDC readiness.

## Controlled deployment blueprint

The repository's [`render.yaml`](../render.yaml) describes two independent
Docker-based processes in Frankfurt:

1. `satn-staging-api`, a paid web service. Its `preDeployCommand` applies
   Prisma migrations once per API deployment **after** migration review and
   backup/restore proof. Readiness requires PostgreSQL, Redis, and a current
   worker heartbeat.
2. `satn-staging-worker`, a separately supervised paid background worker with
   no public ingress, no venue order-writing handler and durable lease fencing.

Both services have auto-deployment switched **off**, and default to
`EXECUTION_MODE=PAPER` and `LIVE_EXECUTION_ENABLED=false`. They reference
the same reviewed backend Dockerfile. This Blueprint deliberately creates
**no databases and no key-value stores**; it cannot duplicate the existing
resources. It is not applied automatically just because it exists in GitHub.

### Paid-resource gate

**Do not sync the Blueprint or create paid API/worker services without
an explicit cost decision.** Two starter compute plans have a published base
price of approximately **US$14 per month combined** at 24/7 usage, subject
to current Render billing, deployment duration, bandwidth and build charges.
That figure **does not include** paid PostgreSQL, a persistence-capable Key
Value plan, identity provider, observability or other operational costs.
Final amounts must be verified against Render billing before acceptance.

The free PostgreSQL instance does not satisfy backup/restore release gates,
and the free Key Value instance loses its state during restarts. They must
be replaced or upgraded before public staging exposure. Full deployment is
therefore not currently authorised by the infrastructure evidence.

### Identity, TLS and secret requirements

The Blueprint requires operators to supply these values through Render's
protected secret entry UI, **never as git literals**:

- `DATABASE_URL` pointing to the appropriate isolated PostgreSQL with
  `sslmode=require` or more restrictive TLS.
- `REDIS_URL` using `rediss://` and a reachable, authenticated TLS endpoint.
  Render's default internal Key Value URL uses `redis://`; do **not** treat
  it as compliant with the hardened `rediss://` release gate.
- `WEB_ORIGIN` set to the exact authorised Vercel HTTPS origin.
- Real `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URL` from an
  operator-controlled identity tenant, with MFA and audited role assignments.

Do not set `AGENT_REGISTRATION_TOKEN` in internet-facing environments.
Do not attach wallets, market-making keys or exchange credentials.

### Release acceptance sequence

1. Verify approved monthly cost, the workspace and region, the exact source
   SHA, protected secrets and the declared operator/risk owner.
2. Use persistent managed database and cache instances; verify independent
   PostgreSQL restore and document RPO/RTO evidence. Confirm TLS, Redis
   authentication, and network restrictions with no public secret exposure.
3. Verify OIDC issuer, audience, JWKS, moderation roles and operator MFA
   against disposable accounts; deny registration when identity fails.
4. Validate the Blueprint and preflight with the real target environment.
   Apply it only after all prior gates have independent evidence.
5. Deploy the API migration release and worker in a controlled order.
   Inspect migration results and worker supervision. Assert
   `/health/ready` returns HTTP 200 **only** when all services are healthy.
6. Exercise SIGTERM/restart/worker-stale, rate-limit Redis disconnect, OIDC
   positive/negative tests, agent journal writes, publication visibility,
   and deterministic PAPER order journals against deployed services.
7. Configure `NEXT_PUBLIC_SATN_API_URL` on Vercel to the real authorised
   HTTPS API endpoint. Rebuild and check the browser CORS flow with
   short-lived test identities.
8. Capture service IDs, commit, URLs, UTC times, health, security checks,
   backup/restore result, browser E2E, alert delivery, rollback and
   explicit release approval. Publish no private credentials.

The full [staging release gates](STAGING_RELEASE_GATES.md) and
[container runbook](STAGING_CONTAINER_RUNBOOK.md) remain authoritative.
No testnet or mainnet order execution is permitted.
