# Domain Model

## Entities
| Entity | Purpose | Key fields |
|---|---|---|
| User | Human owner/operator | id, auth_subject, role, status |
| Agent | Agent identity | id, owner_id, status, mode, version |
| AgentCredential | Machine identity | id, agent_id, credential_hash, scopes, expires_at, revoked_at |
| StrategyVersion | Immutable strategy metadata | id, agent_id, version, config_hash, code_ref |
| VenueConnection | Account mapping | id, owner_id, venue, account_ref, permissions, status |
| RiskPolicy | Versioned limits | id, scope, version, limits, effective_at |
| TradeIntent | Requested economic action | id, agent_id, venue, instrument, side, quantity, idempotency_key, payload_hash, status |
| RiskDecision | Risk result | id, intent_id, outcome, reason_codes, policy_version |
| ExecutionPermit | Narrow authorisation | id, intent_hash, account_ref, venue, max_notional, expiry, nonce, consumed_at |
| VenueOrder | Venue-side order | id, intent_id, client_order_id, venue_order_id, state |
| Fill | Execution evidence | id, order_id, fill_ref, price, quantity, fee, fee_asset, timestamp |
| PositionSnapshot | Point-in-time exposure | id, account_ref, venue, instrument, quantity, mark_price, captured_at |
| JournalEntry | Social/trading narrative | id, agent_id, strategy_version_id, body, provenance, revision |
| EvidenceReference | Evidence pointer/hash | id, entity_type, entity_id, source, external_ref, content_hash |
| AuditEvent | Append-only transition | id, actor, action, target, correlation_id, payload_hash, occurred_at |
| VenueHealth | Integration health | venue, status, last_success_at, data_age_ms, reason |
| PerformanceSnapshot | Reproducible metrics | agent_id, mode, window, methodology_version, pnl_net, max_drawdown, sample_size, quality_flags |

## Invariants
- UUID/ULID IDs; IDs are never authorisation.
- Money/quantities use decimal-safe representations and decimal/numeric DB types.
- Store UTC timestamps plus source timestamps where available.
- Idempotency key is unique per authenticated principal and endpoint scope.
- One venue order can have multiple partial fills.
- Reconciliation adds corrected observations; it does not erase history.
- Strategy versions are immutable; edits create new versions.
- Performance records include mode and provenance.
- Permit is short-lived, single-use, payload-bound and policy-version-bound.
- Revoked agents, unknown accounts and stale market/portfolio state cannot receive new risk-increasing permits.

## Accounting
Track gross realised P&L; fees/rebates; funding/borrow costs; net realised P&L; unrealised P&L separately; deposits/withdrawals/transfers separately; valuation source; methodology version; reporting window and evidence completeness. Never mix paper and live metrics without explicit labels.

## Example intent
```json
{
  "venue": "hyperliquid",
  "instrument": "BTC",
  "instrumentType": "PERPETUAL",
  "side": "BUY",
  "orderType": "LIMIT",
  "quantity": "0.001",
  "limitPrice": "65000.00",
  "timeInForce": "GTC",
  "reduceOnly": false,
  "mode": "PAPER",
  "strategyVersionId": "uuid",
  "idempotencyKey": "unique-client-key"
}
```
Illustrative schema only; not a recommendation to trade.
