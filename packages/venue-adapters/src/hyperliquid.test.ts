import { describe, expect, it } from "vitest";
import { assertFreshSnapshot } from "./index.js";
import { HyperliquidReadOnlyAdapter } from "./hyperliquid.js";

const nowMs = Date.parse("2026-10-30T12:00:00.000Z");
const book = {
  coin: "BTC",
  time: nowMs - 1_000,
  levels: [
    [{ px: "99.5", sz: "2.5", n: 3 }],
    [{ px: "100", sz: "1.2", n: 2 }]
  ]
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Hyperliquid read-only adapter", () => {
  it("requests an L2 book and normalises the top of book", async () => {
    let requestBody = "";
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return response(book);
    };
    const adapter = new HyperliquidReadOnlyAdapter({ fetcher, now: () => nowMs });
    const snapshot = await adapter.getMarketSnapshot("BTC");

    expect(JSON.parse(requestBody)).toEqual({ type: "l2Book", coin: "BTC" });
    expect(snapshot).toMatchObject({
      venue: "hyperliquid",
      instrumentId: "BTC",
      observedAt: new Date(book.time).toISOString(),
      receivedAt: new Date(nowMs).toISOString(),
      bid: "99.5",
      ask: "100",
      dataQuality: "LIVE"
    });
    expect(adapter.submitOrder).toBeUndefined();
    expect(adapter.cancelOrder).toBeUndefined();
  });

  it("marks stale data without pretending it is live", async () => {
    const fetcher: typeof fetch = async () => response({ ...book, time: nowMs - 10_000 });
    const adapter = new HyperliquidReadOnlyAdapter({
      fetcher,
      now: () => nowMs,
      maxAgeMs: 5_000
    });
    const snapshot = await adapter.getMarketSnapshot("BTC");
    expect(snapshot.dataQuality).toBe("STALE");
  });

  it("rejects non-success HTTP responses", async () => {
    const fetcher: typeof fetch = async () => response({ error: "rate limited" }, 429);
    const adapter = new HyperliquidReadOnlyAdapter({ fetcher, now: () => nowMs });
    await expect(adapter.getMarketSnapshot("BTC")).rejects.toThrow(/HTTP 429/);
  });

  it("rejects mismatched or empty order books", async () => {
    const fetcher: typeof fetch = async () => response({ ...book, coin: "ETH" });
    const adapter = new HyperliquidReadOnlyAdapter({ fetcher, now: () => nowMs });
    await expect(adapter.getMarketSnapshot("BTC")).rejects.toThrow(/incomplete or mismatched/i);
  });

  it("rejects malformed top-of-book prices", async () => {
    const fetcher: typeof fetch = async () =>
      response({ ...book, levels: [[{ px: "NaN", sz: "1", n: 1 }], book.levels[1]] });
    const adapter = new HyperliquidReadOnlyAdapter({ fetcher, now: () => nowMs });
    await expect(adapter.getMarketSnapshot("BTC")).rejects.toThrow(/invalid top-of-book/i);
  });

  it("rejects unsafe coin identifiers before making a request", async () => {
    let called = false;
    const fetcher: typeof fetch = async () => {
      called = true;
      return response(book);
    };
    const adapter = new HyperliquidReadOnlyAdapter({ fetcher, now: () => nowMs });
    await expect(adapter.getMarketSnapshot("BTC\norder")).rejects.toThrow(/invalid.*identifier/i);
    expect(called).toBe(false);
  });

  it("rejects future-dated snapshots at the shared freshness gate", () => {
    expect(() =>
      assertFreshSnapshot({
        venue: "hyperliquid",
        instrumentId: "BTC",
        observedAt: new Date(nowMs + 1).toISOString(),
        receivedAt: new Date(nowMs).toISOString(),
        source: "test",
        bid: "99.5",
        ask: "100",
        dataQuality: "LIVE"
      }, nowMs, 5_000)
    ).toThrow(/stale or unknown quality/i);
  });
});
