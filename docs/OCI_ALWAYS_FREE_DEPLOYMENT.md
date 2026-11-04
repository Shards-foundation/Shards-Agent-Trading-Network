# SATNS: Oracle Cloud Always Free exploration (read-only)

**State: PREPARED, NOT CONNECTED, NOT DEPLOYED.** The approved wallet and agent-onboarding previews are unchanged. This work does not create Oracle instances, activate identity providers, apply database migrations, spend money or enable live trading.

## What is implemented

- [Manual OCI inventory workflow](../.github/workflows/satns-oci-readonly.yml): GitHub Actions can inspect an operator-approved compartment **only after** OCI identity trust and protected GitHub settings are in place. There are no create/update/delete OCI SDK calls or resources.
- [Read-only Oracle SDK client](../deploy/oci/inventory.py): exchanges the GitHub Actions OIDC JWT for a short-lived OCI resource principal token and uses **list** operations for region subscriptions, instances, boot volumes and VCNs. Results are aggregate counts; never output private keys, tokens, secrets, OCIDs, addresses, instance names or SDK exception bodies.
- [Always Free candidate gate](../scripts/oci-free-policy.mjs): no-network, no-side-effect, separately unit-tested checks for **home region**, exact `VM.Standard.A1.Flex` shape, maximum **2 A1 OCPUs**, **12 GB A1 memory**, **200 GB combined boot/block storage**, no-paid intent and tenancy-wide evidence. Passing its static check is **not evidence of capacity, billing eligibility or an actual deployed instance**.

The Oracle allocation is region-dependent and may be unavailable. Instances can be reclaimed under Oracle's idle-resource policy. A real free-cost check requires live operator inspection of all compartments, live quotas, account status and the creation estimate.

## Connect GitHub to OCI without a long-lived OCI API key

Oracle supports **JWT-to-RPST workload federation**, including GitHub Actions, since August 2026. This is a **two-system trust configuration**: GitHub's OIDC token alone does **not** grant OCI access.

**Important:** the currently documented OCI Python SDK `TokenExchangeSigner` also authenticates the token exchange with an **OAuth client ID and OAuth client secret**. Avoiding a permanent OCI API signing key is **not** the same as eliminating all stored secrets. The client secret must only be stored as a protected, rotating **GitHub environment secret**; never post it in chat.

1. **Oracle operator (one time):** identify the real OCI tenancy and **home region**, inspect existing Always Free allocations and capacity. Create a dedicated _read-only_ OCI identity-domain OAuth client and Identity Propagation Trust for issuer `https://token.actions.githubusercontent.com`. Trust must validate exact `repository=Shards-foundation/Shards-Agent-Trading-Network`, `ref=refs/heads/main` and `job_workflow_ref=Shards-foundation/Shards-Agent-Trading-Network/.github/workflows/satns-oci-readonly.yml@refs/heads/main`. Restrict the resource principal to **inspect/list** permissions for the selected compartment, relevant tenancy region metadata and networking. No `manage` permissions, broad administrators or multi-repository wildcard claims. Verify the actual claims in the secure session without printing JWTs.
2. **GitHub operator (one time):** protect `main` against unreviewed edits. The workflow checks the GitHub branch API for `protected=true` and will stop otherwise. Configure an environment named **`satns-oci-inventory`** restricted to `main`, with required human review and no administrator bypass where supported. Previously the project's main branch reported `protected=false`: this is a real current blocker until fixed.
3. Enter the following **environment** settings in GitHub's UI—not in this chat and not in Git:

| Key                             | Type       | Meaning                                                       |
| ------------------------------- | ---------- | ------------------------------------------------------------- |
| `SATNS_OCI_HOME_REGION`         | variable   | Actual tenancy home region, e.g. `uk-london-1`                |
| `SATNS_OCI_TENANCY_OCID`        | variable   | Tenancy OCID                                                  |
| `SATNS_OCI_COMPARTMENT_OCID`    | variable   | Inspected compartment OCID                                    |
| `SATNS_OCI_IDENTITY_DOMAIN_URL` | variable   | HTTPS identity-domain origin under `identity.oraclecloud.com` |
| `SATNS_OCI_OAUTH_CLIENT_ID`     | variable   | Dedicated OAuth token-exchange client ID                      |
| `SATNS_OCI_OAUTH_CLIENT_SECRET` | **secret** | Token-exchange client secret; rotate as required              |

4. **After the PR is reviewed and the code reaches protected main**, run **Actions → SATNS OCI Always Free discovery (manual, read-only)** and provide the exact current 40-character `main` SHA. The job refuses an unprotected main, an unexpected SHA, an incorrect repository, non-PAPER mode and incomplete configuration. It never provisions. If permissions, provider capacity or credentials are unavailable, report **BLOCKED**, not success.

## Shards migration strategy — not executed

Retain the approved [#77](https://github.com/Shards-foundation/Shards-Agent-Trading-Network/pull/77) wallet/market UI and [#78](https://github.com/Shards-foundation/Shards-Agent-Trading-Network/pull/78) onboarding UI on Vercel. The existing [Dockerfile](../deploy/Dockerfile) produces two independent Node.js processes: `apps/api/dist/index.js` and `apps/api/dist/worker-main.js`. Deploying the same image on ARM64 is an **unverified candidate** until an actual ARM64 build and live worker/health checks pass.

Keep the existing Neon PostgreSQL database and its historical preview branches intact initially. The [staging Compose](../deploy/compose.staging.yml) requires **external TLS PostgreSQL, authenticated `rediss://` Redis and a separate valid OIDC identity provider**, and deliberately binds the API to loopback. A plain on-VM `redis://` service does **not** satisfy the current staging security contract; any change to this is a separately reviewed security decision.

The **Oracle GitHub workload identity** is not the human/agent **Shards OIDC provider**. Human signup and wallet ownership verification remain unavailable until the backend, worker, OIDC and real device flows are deployed and tested.

### Explicit no-charge and release gates

- Verify Oracle tenancy/account free status, home region, **all-compartment** compute/disk allocations, service quotas, ARM capacity and price shown at the moment of provisioning. If any item has a nonzero charge or uncertainty, **stop**. Do not upgrade to PAYG, purchase storage, create paid network services or enable paid monitoring.
- Require an actual ARM64 container build, supervised worker heartbeat and 503→200→503 readiness behavior on worker stop/restart; keep `EXECUTION_MODE=PAPER`, `LIVE_EXECUTION_ENABLED=false`, no venue signers or agent wallet authority.
- Perform independently verified Neon backup **and restore**, schema migration review, secure ingress, TLS, log redaction, monitoring and rollback before any public API.
- Complete `agent register → human claim → one-time activate → private journal` and real-wallet `connect → sign proof → assign/revoke` acceptance with disposable accounts and devices. Do not confuse browser screenshots, GitHub CI, or Vercel READY previews with hosted operational proof.

### Primary documentation

- [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [OCI identity-domain JWT-to-RPST token exchange](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/token_exchange_grant_type_workload_id-federation.htm)
- [Oracle Python SDK TokenExchangeSigner example](https://github.com/oracle/oci-python-sdk/blob/master/examples/workload_identity_federation_signer_example.py)
- [GitHub OIDC reference and claims](https://docs.github.com/en/actions/reference/security/oidc)

The GitHub connector can modify and validate **repository automation**, but it is **not** an OCI account session. The external OCI identity-domain trust and the GitHub environment secret require the account operator's secure configuration. Until those gates are complete, real OCI inspection and deployment cannot be reported as executed.
