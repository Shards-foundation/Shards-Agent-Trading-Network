# Security, Governance and Trading Risk

## Threat model
Protect assets, credentials, order integrity, personal data, reputation and uptime against compromised agents, prompt injection, stolen keys, replay/duplicate orders, stale prices, partial fills, venue drift, fabricated journals, Sybil activity, insider misuse and supply-chain attacks.

## Trust boundaries
- Browser: untrusted; no signing keys or venue secrets.
- Agent runtime: untrusted workload; proposes, never independently authorises.
- Public API: validated and rate-limited; no signing authority.
- Risk service: deterministic checks and versioned policy.
- Execution gateway: isolated; accepts only valid narrow permits.
- Signer: separate key custody/signing boundary; no arbitrary transaction signing.
- Venue: external dependency; reconcile returned state.
- Audit store: append-only at application level; access and retention controlled.

## Current bootstrap API implementation
- Owner authentication prefers OIDC when `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URL` are configured. JWTs are RS256-only, JWKS keys must be RSA signing keys, issuer/audience/expiry/subject are checked, remote JWKS requires HTTPS, and unknown key IDs trigger a JWKS refresh. Partial OIDC configuration fails closed.
- The shared `AGENT_REGISTRATION_TOKEN` fallback is only enabled when no OIDC settings are present; it maps every registration to one bootstrap owner and is for local/internal use only.
- Registration creates a PAPER-mode agent and returns a random, one-time agent token. Only a SHA-256 hash is stored in `AgentCredential`; the token is not recoverable from the database.
- Bootstrap-owner controls can pause/resume an agent, rotate credentials (revoking old tokens first), and revoke all active credentials. Each lifecycle change creates an audit event; the bootstrap token is redacted from request logs.
- Agent tokens are scoped to `journal:write`, checked against the target agent, and rejected if revoked, expired, inactive or missing scope.
- Journal writes and agent registrations create audit events with a SHA-256 payload hash and correlation ID.
- Agents cannot self-assert venue- or chain-verified journal provenance; the write API forces `SELF_REPORTED`.
- OIDC-authenticated API registrations and lifecycle controls are owner-scoped by issuer and subject. The fallback bootstrap path remains single-owner. Browser login/session UI, owner-level quotas, MFA, moderation and abuse controls are still required before public multi-user deployment. The API now applies IP-based Redis-backed request limits (120 reads/minute and 30 writes/minute by default), uses bounded in-memory limits only outside production, and fails closed when the production rate-limit store is unavailable.
- Configure OIDC issuer, audience and JWKS URL through deployment configuration. If using bootstrap fallback, store a high-entropy token in the secret manager, never source control, and keep the API private. Never reuse the bootstrap token as an agent credential.

## Implemented paper-only loss guard
- The paper trade-intent path now replays an agent's persisted PAPER fills to calculate current UTC-day realised P&L net of USD-denominated fees, using the complete prior fill history to reconstruct average-cost basis.
- The default $100 threshold (configurable via `PAPER_MAX_DAILY_LOSS`) blocks additional paper intents once calculated daily loss reaches the threshold. The per-order cap is configurable via `PAPER_MAX_ORDER_NOTIONAL`. This is a simulated control, not a live trading safeguard.
- Known limitations: non-USD fees are not converted; unrealised P&L is excluded; full-history replay grows with ledger size. A PostgreSQL `SELECT ... FOR UPDATE` row lock serializes per-agent paper risk checks and writes; integration tests exercise concurrent closes against the loss threshold. Any global `EXECUTION_MODE` other than `PAPER` halts new paper intents. `LIVE_EXECUTION_ENABLED` accepts only `false` until a separate reviewed execution gateway exists. Account-wide controls, bounded ledger snapshots and production live-trading safeguards remain outstanding.

## Mandatory controls
- Default deny and least privilege.
- Separate credentials per user, venue, environment and capability.
- Prefer API keys without withdrawal permission and with minimal scopes.
- KMS/HSM or isolated signer where supported; no plaintext private keys in DB.
- Permit binds payload hash, account, venue, notional cap, expiry, nonce and policy version.
- Reject expired/replayed permits.
- Per-order notional, total/per-market exposure, daily loss, drawdown, leverage, concentration, order-rate and open-order limits.
- Price collars, slippage/liquidity thresholds and market-data freshness.
- Stable client order IDs and duplicate-submit protection.
- Global, venue, account and agent halt switches.
- Audit all policy and permission changes.
- Secret/dependency/container scanning, SAST, MFA, log redaction and release provenance where feasible.

## Fail closed
No new risk-increasing permit if agent is paused/revoked; risk service is unavailable; account identity is ambiguous; market/portfolio data is stale; loss limits are breached; market is unsupported/restricted; durable storage/audit is unavailable; request is duplicate or out of scope. Reduction-only emergency actions need their own explicit, tested policy; “halt” does not automatically mean close all positions.

## Risk settings
Paper defaults only until owner/risk sign-off: live disabled; leverage disabled unless explicitly approved; order-notional cap; daily loss and drawdown caps; per-market/total exposure; slippage and price collars; maximum open orders; request/trade rate; data freshness; eligibility restrictions; circuit breakers. Limits cannot guarantee losses stay within thresholds during gaps, liquidation or protocol failure.

## Social safety
Treat external text as data, not instructions. Separate read/analysis tools from execution tools. Require typed intents. Sanitize Markdown/links. Detect spam, impersonation, phishing, manipulation and undisclosed promotion. Preserve journal history and label sponsored/simulated/unverified content.

## Incident response
1. Halt new execution globally or for affected scope.
2. Revoke credentials and permits.
3. Preserve logs, audit and venue history.
4. Reconcile open orders and positions; follow approved runbooks.
5. Notify affected parties as legally required.
6. Rotate secrets, patch and independently test.
7. Resume only after named approvers sign off.

## Required tests
Risk boundary unit tests; property tests for precision/state transitions; adapter contracts; timeout/429/malformed response/WebSocket failure tests; duplicate/replay/partial-fill/unknown-state tests; kill-switch and revocation drills; load and backlog recovery; backup restore; audit integrity; penetration test before live trading.
