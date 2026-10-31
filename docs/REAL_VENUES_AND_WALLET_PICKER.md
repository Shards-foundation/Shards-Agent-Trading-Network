# Real Venue Data and Reown Wallet Picker — Phase 2

Status: **Public market-data integration and wallet transport**, not live trading.
Feature branch: `feat/live-venues-reown-wallet-picker`.

## Provider integration matrix

| Surface                      | Official provider                           | Route                                           | Reality                                                                                                     |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hyperliquid Perpetuals       | `https://api.hyperliquid.xyz/info`          | `/api/venues/hyperliquid`                       | Real `metaAndAssetCtxs` mark, 24h, funding, leverage; 15s refresh                                           |
| Hyperliquid L2 book          | Same                                        | `/api/venues/hyperliquid/book?symbol=BTC`       | Real venue book timestamp; stale >30s rejected                                                              |
| Hyperliquid public accounts  | `https://api.hyperliquid.xyz/info`          | `/api/venues/hyperliquid/account?address=0x...` | Actual `clearinghouseState` and `openOrders`, manually requested, no signing                                |
| Polymarket predictions       | `https://gamma-api.polymarket.com/markets`  | `/api/venues/polymarket`                        | Real Gamma markets, outcomes, token IDs, 30s refresh                                                        |
| Polymarket CLOB depth        | `https://clob.polymarket.com/book`          | `/api/venues/polymarket/book?tokenId=...`       | Actual outcome-token book. Not a trade quotation guarantee                                                  |
| Multi-chain wallet selection | **Reown AppKit** via Wagmi + Solana adapter | `/wallets`                                      | WalletConnect catalogue, installed EVM wallets and deep links; Solana injected wallets supported separately |

Both venues remain **non-signing and execution-disabled**. Public display does not imply custody or instrument/trader eligibility. Browser and backend always gate live trading independently.

## Deployment configuration

1. Create a **Shards-owned** Reown AppKit project at https://dashboard.reown.com and configure the correct approved domains.
2. Set Vercel `NEXT_PUBLIC_REOWN_PROJECT_ID` to its public project ID in the Preview environment; scope origin as `NEXT_PUBLIC_APP_ORIGIN`, e.g. the exact preview domain. These two values are public identifiers, **never private wallet keys**.
3. Rebuild the web preview and confirm the AppKit modal actually opens and discovers wallet brands. Do not copy a demo or third-party AppKit project ID.
4. Test EVM account selection, Solana wallet selection, QR/deeplink, cancel, disconnect, network changes and session restoration on Samsung Internet/Android Chrome and wallet browsers.
5. Test the Reown Solana `signMessage` path on a disposable wallet, then confirm backend Ed25519 ownership proof and one-time nonce invalidation. Ensure no transaction signature or token approval is requested.
6. Note: Reown AppKit is subject to its own SDK **Community License** and potential commercial use/MAU/RPC requirements. Shards Inc should review those terms before a commercial launch. Reown project creation may also be subject to service limits.

## Supported future execution

Hyperliquid real order execution requires venue-specific signing, max notional/leverage, risk limits, deterministic per-order permits and independent reconciliation. Use an explicitly limited Hyperliquid API wallet, never a master key or browser session cookie.

Polymarket uses official CLOB L1/L2 authentication and signed orders; its UK geographic restrictions **block trading**, including via an AI agent or a server outside the UK. Public discovery is still useful. The venue/geoblock status must be freshly enforced where execution is legally available, not inferred from browser hints.

Do not add a generic `POST /trade` endpoint with an unrestricted signer. A quote, a verified owner wallet and a delegated execution permission are separate security objects.

## Source references

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- https://docs.polymarket.com/
- https://help.polymarket.com/en/articles/13364163-geographic-restrictions
- https://github.com/reown-com/appkit-web-examples/tree/main/nextjs/next-multichain-app-router
- https://github.com/reown-com/appkit/blob/main/README.md

## Security dependency decision

The Reown Solana adapter has been removed because CI found a high-severity unpatched bigint-buffer dependency via Solana SPL token internals. Do not suppress the dependency audit. We retain the existing server-verified Solana injected-wallet flow. The Reown modal covers the EVM wallet catalogue until a remediated Solana wallet-connect integration is available. The root pnpm override policy also constrains ws >=8.21.0, zod >=4.6.7 and decode-uri-component >=0.5.1. Dependency installation and security audit must verify these constraints before release.

## Hyperliquid account inspector boundaries

The Perpetuals view includes a manual public-address lookup for real Hyperliquid margin balances, open positions and orders. This is a public info API query, **not** wallet ownership verification or account authorisation. Never imply the account is the signed-in user's account merely because its address was entered. It does not display other users' balances without a deliberate address lookup; production should add edge rate limits/abuse controls for arbitrary public-address queries. Results are retrieved only when the user submits an address and never carry signing keys or live order permissions.
