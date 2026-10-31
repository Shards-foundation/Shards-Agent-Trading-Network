import assert from "node:assert/strict";

const urls = {
  hyperliquid: "https://api.hyperliquid.xyz/info",
  gamma: "https://gamma-api.polymarket.com/markets",
  clob: "https://clob.polymarket.com/book",
};
async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    headers: { accept: "application/json", ...init.headers },
    ...init,
  });
  assert.ok(response.ok, `External contract probe failed: ${new URL(url).hostname} HTTP ${response.status}`);
  const text = await response.text();
  assert.ok(text.length > 0 && text.length < 4_000_000, "Invalid venue payload size");
  return JSON.parse(text);
}
const hyperliquid = await jsonRequest(urls.hyperliquid, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "" }),
});
assert.ok(Array.isArray(hyperliquid) && hyperliquid.length === 2, "Hyperliquid context envelope");
const [meta, contexts] = hyperliquid;
assert.ok(Array.isArray(meta?.universe) && Array.isArray(contexts), "Hyperliquid context arrays");
assert.equal(meta.universe.length, contexts.length, "Hyperliquid array index alignment");
const btcIndex = meta.universe.findIndex((entry) => entry?.name === "BTC");
assert.ok(btcIndex >= 0, "Hyperliquid BTC perpetual missing");
assert.ok(Number(contexts[btcIndex]?.markPx) > 0, "Hyperliquid BTC mark missing");
assert.ok(Number.isFinite(Number(contexts[btcIndex]?.funding)), "Hyperliquid BTC funding missing");
console.info(JSON.stringify({
  venue: "hyperliquid",
  status: "real_public_api_verified",
  markets: meta.universe.length,
  btcMarkValid: true,
}));

const gammaUrl = new URL(urls.gamma);
Object.entries({ active: "true", closed: "false", limit: "20", order: "volume24hr", ascending: "false" })
  .forEach(([key, value]) => gammaUrl.searchParams.set(key, value));
const markets = await jsonRequest(gammaUrl.toString());
assert.ok(Array.isArray(markets) && markets.length > 0, "Gamma returned no public markets");
const tokens = markets.flatMap((market) => {
  let ids = market?.clobTokenIds;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { return []; }
  }
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && /^\d{10,100}$/.test(id)) : [];
}).slice(0, 8);
assert.ok(tokens.length > 0, "Gamma did not return a usable CLOB token ID");
console.info(JSON.stringify({
  venue: "polymarket-gamma",
  status: "real_public_api_verified",
  markets: markets.length,
  mappedOutcomeTokens: tokens.length,
}));

let clobVerified = false;
for (const tokenId of tokens) {
  try {
    const url = new URL(urls.clob);
    url.searchParams.set("token_id", tokenId);
    const book = await jsonRequest(url.toString());
    if (book?.asset_id === tokenId && Array.isArray(book.bids) && Array.isArray(book.asks)) {
      clobVerified = true;
      break;
    }
  } catch {
    // Not every outcome token is actively order-book tradable. Try the next
    // public outcome token rather than assuming Gamma metadata implies a live book.
  }
}
assert.equal(clobVerified, true, "No matching Polymarket CLOB book could be verified");
console.info(JSON.stringify({
  venue: "polymarket-clob",
  status: "real_public_api_verified",
  readOnly: true,
  orderExecutionEnabled: false,
}));
