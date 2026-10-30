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
