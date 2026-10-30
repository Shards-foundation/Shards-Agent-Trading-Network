import { describe, expect, it } from "vitest";
import { simulateLimitOrder } from "./index.js";

const nowMs = Date.parse("2026-10-30T12:00:00.000Z");
const snapshot = {
  venue: "hyperliquid",
  instrumentId: "BTC-USD",
  observedAt: "2026-10-30T11:59:59.000Z",
  bid: "99.5",
  ask: "100",
  dataQuality: "LIVE" as const
};
const baseOrder = {
  side: "BUY" as const,
  quantity: "2",
  limitPrice: "100",
  feeBps: 10
};
const options = { nowMs, maxSnapshotAgeMs: 2_000 };

describe("paper execution boundaries", () => {
  it("labels results as simulated and calculates fees with integer arithmetic", () => {
    const result = simulateLimitOrder(baseOrder, snapshot, options);
    expect(result).toMatchObject({
      mode: "PAPER",
      status: "FILLED",
      fillPrice: "100",
      notional: "200",
      fee: "0.2",
      evidenceLabel: "SIMULATED",
      reason: "LIMIT_CROSSED"
    });
  });

  it("does not fill a buy when the ask exceeds its limit", () => {
    const result = simulateLimitOrder({ ...baseOrder, limitPrice: "99.99" }, snapshot, options);
    expect(result.status).toBe("NOT_FILLED");
    expect(result.fillPrice).toBeNull();
    expect(result.notional).toBe("0");
    expect(result.fee).toBe("0");
  });

  it("fills a sell only when the bid meets or exceeds its limit", () => {
    const result = simulateLimitOrder(
      { ...baseOrder, side: "SELL", limitPrice: "99.5" },
      snapshot,
      options
    );
    expect(result.status).toBe("FILLED");
    expect(result.fillPrice).toBe("99.5");
    expect(result.notional).toBe("199");
  });

  it("rejects delayed market data", () => {
    expect(() =>
      simulateLimitOrder(baseOrder, { ...snapshot, dataQuality: "DELAYED" }, options)
    ).toThrow(/fresh, known-quality/i);
  });

  it("rejects stale market data", () => {
    expect(() =>
      simulateLimitOrder(
        baseOrder,
        { ...snapshot, observedAt: "2026-10-30T11:59:00.000Z" },
        options
      )
    ).toThrow(/fresh, known-quality/i);
  });

  it("rejects future-dated market data", () => {
    expect(() =>
      simulateLimitOrder(
        baseOrder,
        { ...snapshot, observedAt: "2026-10-30T12:00:01.000Z" },
        options
      )
    ).toThrow(/fresh, known-quality/i);
  });

  it("rejects a crossed or inverted book", () => {
    expect(() =>
      simulateLimitOrder(baseOrder, { ...snapshot, bid: "100.1", ask: "100" }, options)
    ).toThrow(/invalid bid\/ask/i);
  });

  it("rejects zero quantity", () => {
    expect(() =>
      simulateLimitOrder({ ...baseOrder, quantity: "0" }, snapshot, options)
    ).toThrow();
  });

  it("rejects zero limit price", () => {
    expect(() =>
      simulateLimitOrder({ ...baseOrder, limitPrice: "0" }, snapshot, options)
    ).toThrow();
  });

  it("rejects negative quantity", () => {
    expect(() =>
      simulateLimitOrder({ ...baseOrder, quantity: "-1" }, snapshot, options)
    ).toThrow();
  });

  it("rejects precision beyond eight decimal places", () => {
    expect(() =>
      simulateLimitOrder({ ...baseOrder, limitPrice: "1.123456789" }, snapshot, options)
    ).toThrow();
  });

  it("rejects invalid fee basis points", () => {
    expect(() =>
      simulateLimitOrder({ ...baseOrder, feeBps: 10_001 }, snapshot, options)
    ).toThrow();
  });
});
