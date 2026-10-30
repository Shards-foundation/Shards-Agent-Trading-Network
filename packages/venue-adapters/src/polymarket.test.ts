import { describe, expect, it } from "vitest";
import { PolymarketReadOnlyDiscoveryAdapter } from "./polymarket.js";
const nowMs = Date.parse("2026-10-30T12:00:00.000Z");
const market = { id: "123", question: "Will BTC close above $100k?", slug: "btc-above-100k", conditionId: "0xcondition",
  outcomes: '["Yes","No"]', outcomePrices: '["0.65","0.35"]', active: true, closed: false,
  volumeNum: 1234.5, liquidityNum: 90.25, endDate: "2026-12-31T00:00:00Z", acceptingOrders: true, restricted: false };
function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
describe("Polymarket read-only market discovery adapter", () => {
  it("queries open markets and normalises JSON-encoded outcome fields", async () => {
    let requestedUrl = "";
    const adapter = new PolymarketReadOnlyDiscoveryAdapter({ fetcher: async (input) => { requestedUrl = String(input); return response([market]); }, now: () => nowMs });
    const page = await adapter.listMarkets({ limit: 20, offset: 40 });
    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://gamma-api.polymarket.com/markets");
    expect(url.searchParams.get("closed")).toBe("false");
    expect(url.searchParams.get("offset")).toBe("40");
    expect(page).toMatchObject({ venue: "polymarket", retrievedAt: new Date(nowMs).toISOString(), executionEnabled: false,
      items: [{ id: "123", conditionId: "0xcondition", outcomes: ["Yes","No"], outcomePrices: ["0.65","0.35"], volume: 1234.5, liquidity: 90.25 }] });
    expect("submitOrder" in adapter).toBe(false);
  });
  it("rejects invalid pagination before making a request", async () => {
    let called = false;
    const adapter = new PolymarketReadOnlyDiscoveryAdapter({ fetcher: async () => { called = true; return response([]); } });
    await expect(adapter.listMarkets({ limit: 100, offset: 0 })).rejects.toThrow(/limit/);
    await expect(adapter.listMarkets({ limit: 10, offset: -1 })).rejects.toThrow(/offset/);
    expect(called).toBe(false);
  });
  it("rejects malformed outcome JSON and mismatched outcome arrays", async () => {
    const malformed = new PolymarketReadOnlyDiscoveryAdapter({ fetcher: async () => response([{ ...market, outcomes: "not-json" }]) });
    await expect(malformed.listMarkets({ limit: 10, offset: 0 })).rejects.toThrow(/malformed outcomes/i);
    const mismatch = new PolymarketReadOnlyDiscoveryAdapter({ fetcher: async () => response([{ ...market, outcomePrices: '["0.5"]' }]) });
    await expect(mismatch.listMarkets({ limit: 10, offset: 0 })).rejects.toThrow(/invalid outcome prices/i);
  });
  it("sanitises provider failures and rejects unsafe remote HTTP endpoints", async () => {
    const adapter = new PolymarketReadOnlyDiscoveryAdapter({ fetcher: async () => response({ error: "private detail" }, 429) });
    await expect(adapter.listMarkets({ limit: 10, offset: 0 })).rejects.toThrow(/HTTP 429/);
    expect(() => new PolymarketReadOnlyDiscoveryAdapter({ endpoint: "http://example.com/markets" })).toThrow(/HTTPS/);
  });
});
