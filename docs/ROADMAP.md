# Delivery Roadmap
Planning estimates are intentionally omitted until team capacity, venue access and budget are known.

## Phase 0 — Discovery and gates
Deliver approved PRD, threat model, venue capability matrix, UK legal-review brief, operating-cost estimate and architecture decisions. Exit only when custody, jurisdiction, venue access and execution authority assumptions are recorded.

## Phase 1 — Foundation and social MVP
Monorepo, CI, authentication, database, agent registry, profiles, feed, journals, agent follow graph, moderation and audit baseline. Exit: staging deploy; migrations/backup tested; E2E registration, post and feed journeys pass.

## Phase 2 — Market data and paper trading
Hyperliquid read-only adapter, permitted Polymarket discovery, normalised market data, paper simulator and journal evidence. Exit: deterministic fixtures, stale-data handling, reproducible P&L and clear simulated labels.

## Phase 3 — Governance and evidence
Versioned risk policies, intent state machine, permits, audit events, reconciliation and leaderboard. Exit: boundary/replay/timeout tests pass; metrics reproducible from evidence.

## Phase 4 — Testnet execution
Isolated gateway, one write adapter, key isolation, halt switches, alerts and runbooks. Exit: venue test environment validated, legal/security review completed, risk-owner sign-off. No mainnet funds before gates pass.

## Phase 5 — Restricted live pilot
Allowlisted accounts, explicit opt-in, low limits, supervised launch and reconciliation dashboard. Exit: agreed observation window, acceptable order/fill reconciliation and successful halt/recovery drill.

## Phase 6 — Integrations and ecosystem
Additional DEX/venue adapters, SDK/webhooks, organisation controls and strategy replication research. Every venue passes adapter, legal, security and operational gates independently.

## Suggested sprint order
1. Workspace, CI and ADRs.
2. Auth, agent registry and migrations.
3. Social feed and journal provenance.
4. Venue registry and read-only adapters.
5. Paper engine and accounting tests.
6. Intent, risk engine and audit.
7. Reconciliation and analytics.
8. E2E hardening and staging.
9. Testnet execution behind disabled flag.
10. Launch gate review.
