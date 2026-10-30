# Integration Research and External Dependencies
Research snapshot: 30 October 2026. Re-verify official docs and terms before implementation and live launch.

## Hyperliquid
Official docs:
- https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/exchange-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket

The documented Info endpoint uses POST https://api.hyperliquid.xyz/info; signed actions use POST https://api.hyperliquid.xyz/exchange; WebSocket is documented at wss://api.hyperliquid.xyz/ws. Signing, nonce and account/subaccount semantics are venue-specific. Read-only first, then paper, then testnet. Mainnet writes stay disabled until signing, replay, timeout, partial-fill and reconciliation tests pass.

## Polymarket
Official docs: https://docs.polymarket.com/  
Agent authentication material: https://github.com/Polymarket/agent-skills/blob/main/authentication.md

The CLOB interface documents wallet signing and authenticated API credentials. Market data, signatures, wallet/funder configuration and settlement semantics are venue-specific. UK access and eligibility must not be assumed. Start with public market discovery only where permitted; disable execution pending current docs, terms, eligibility and legal review.

## Pump.fun
Official sources:
- https://docs.pump.fun/
- https://docs.pump.fun/getting-started/
- https://docs.pump.fun/terms/
- https://docs.pump.fun/reference/

The documented Developer API is approved-organisation, server-side and read-only for public data; its terms state the key does not create posts, follow, trade, transfer or sign transactions. Do not plan trade execution on this API. Any alternative execution route requires separate verification of capability and permission.

## DEX / Uniswap
Official docs:
- https://developers.uniswap.org/docs/trading/swapping-api/start-building/integration-guide
- https://developers.uniswap.org/docs/trading/overview

The Trading API can quote and construct transaction payloads; the integrating application remains responsible for signing/broadcasting. API keys are required for the documented API. Token approvals, chain IDs, slippage, quote freshness, transaction simulation and token risk must be explicit. Never allow an LLM to sign arbitrary calldata.

## UK legal research
FCA sources:
- https://www.fca.org.uk/firms/cryptoassets
- https://www.fca.org.uk/firms/cryptoassets/who-needs-register

These are research entry points, not a legal conclusion for SATN. Obtain qualified UK legal advice on software-only tooling vs execution/routing, custody, derivatives, prediction-market access, copy trading, financial promotions, referrals, subscriptions and performance fees. Apply geo/access gating based on that advice.

## Initial capability matrix
| Venue | Initial target | Write status |
|---|---|---|
| Hyperliquid | Read-only data and paper | Disabled until testnet/risk gates pass |
| Polymarket | Permitted public discovery | Disabled pending eligibility and legal/API review |
| Pump.fun | Approved public read API | Documented developer API is read-only |
| Uniswap/DEX | Quote/unsigned transaction | Explicit wallet/policy-controlled signing only after review |
| Additional DEX | Deferred | Not selected |

## Source rules
Pin provider schemas when possible. Store source URL, retrieval time, schema and adapter versions for evidence. Use official docs for contracts; do not infer capabilities from third-party bots. Add fixtures and contract tests. Recheck terms, limits, chain support, regional access and deprecations before live launch.
