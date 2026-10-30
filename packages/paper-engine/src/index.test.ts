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

describe("paper execution boundaries", () => {
  it("labels all results as simulated and calculates fees with integer arithmetic", () => {
    const result = simulateLimitOrder(baseOrder, snapshot, { nowMs, maxSnapshotAgeMs: 2_000 });
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
    const result = simulateLimitOrder(
      { ...baseOrder, limitPrice: "99.99" },
      snapshot,
      { nowMs, maxSnapshotAgeMs: 2_000 }
    );
    expect(result.status).toBe("NOT_FILLED");
    expect(result.fillPrice).toBeNull();
    expect(result.notional).toBe("0");
    expect(result.fee).toBe("0");
  });

  it("fills a sell only when the bid meets or exceeds its limit", () => {
    const result = simulateLimitOrder(
      { ...baseOrder, side: "SELL", limitPrice: "99.5" },
      snapshot,
      { nowMs, maxSnapshotAgeMs: 2_000 }
    );
    expect(result.status).toBe("FILLED");
    expect(result.fillPrice).toBe("99.5");
    expect(result.notional).toBe("199");
  });

  it.each([
    ["delayed data", { ...snapshot, dataQuality: "DELAYED" as const }],
    ["stale data", { ...snapshot, observedAt: "2026-10-30T11:59:00.000Z" }],
    ["future-dated data", { ...snapshot, observedAt: "2026-10-30T12:00:01.000Z" }]
  ])("rejects %s", (_label, badSnapshot) => {
    expect(() =>
      simulateLimitOrder(baseOrder, badSnapshot, { nowMs, maxSnapshotAgeMs: 2_000 })
    ).toThrow();
  });

  it("rejects a crossed or inverted book", () => {
    expect(() =>
      simulateLimitOrder(
        baseOrder,
        { ...snapshot, bid: "100.1", ask: "100" },
        { nowMs, maxSnapshotAgeMs: 2_000 }
      )
    ).toThrow(/invalid bid\/ask/i);
  });

  it.each([
    [{ ...baseOrder, quantity: "0" }, "quantity"],
    [{ ...baseOrder, limitPrice: "0" }, "limitPrice"],
    [{ ...baseOrder, quantity: "-1" }, "quantity"],
    [{ ...baseOrder, limitPrice: "1.123456789" }, "limitPrice"]
  ])("rejects invalid order values", (order) => {
    expect(() =>
      simulateLimitOrder(order, snapshot, { nowMs, maxSnapshotAgeMs: 2_000 })
    ).toThrow();
  });

  it("rejects invalid fee basis points", () => {
    expect(() =>
      simulateLimitOrder(
        { ...baseOrder, feeBps: 10_001 },
        snapshot,
        { nowMs, maxSnapshotAgeMs: 2_000 }
      )
    ).toThrow();
  });
});
