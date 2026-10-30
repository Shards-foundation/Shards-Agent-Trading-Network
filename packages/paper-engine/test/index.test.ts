import { describe, expect, it } from "vitest";
import { simulateLimitOrder } from "../src/index.js";

const nowMs = 1_800_000_000_000;
const snapshot = {
  venue: "fixture-venue",
  instrumentId: "BTC-USD",
  observedAt: new Date(nowMs - 100).toISOString(),
  bid: "99",
  ask: "100",
  dataQuality: "LIVE"
};
const order = { side: "BUY", quantity: "2", limitPrice: "100", feeBps: 10 };

describe("paper trading engine", () => {
  it("simulates a crossed buy limit at the ask and labels it simulated", () => {
    expect(simulateLimitOrder(order, snapshot, { nowMs, maxSnapshotAgeMs: 1000 })).toMatchObject({
      mode: "PAPER",
      status: "FILLED",
      fillPrice: "100",
      notional: "200",
      fee: "0.2",
      evidenceLabel: "SIMULATED",
      reason: "LIMIT_CROSSED"
    });
  });

  it("does not fill a buy limit below the ask", () => {
    expect(simulateLimitOrder({ ...order, limitPrice: "99" }, snapshot, { nowMs, maxSnapshotAgeMs: 1000 }))
      .toMatchObject({ status: "NOT_FILLED", fillPrice: null, notional: "0", fee: "0" });
  });

  it("simulates a sell limit at the bid when the bid crosses the limit", () => {
    expect(simulateLimitOrder({ ...order, side: "SELL", limitPrice: "99" }, snapshot, { nowMs, maxSnapshotAgeMs: 1000 }))
      .toMatchObject({ status: "FILLED", fillPrice: "99", notional: "198", fee: "0.198" });
  });

  it("rejects stale or non-live snapshots", () => {
    expect(() => simulateLimitOrder(order, { ...snapshot, dataQuality: "STALE" }, { nowMs, maxSnapshotAgeMs: 1000 }))
      .toThrow(/fresh/);
    expect(() => simulateLimitOrder(order, snapshot, { nowMs, maxSnapshotAgeMs: 50 })).toThrow(/fresh/);
  });

  it("rejects inverted bid/ask data", () => {
    expect(() => simulateLimitOrder(order, { ...snapshot, bid: "101", ask: "100" }, { nowMs, maxSnapshotAgeMs: 1000 }))
      .toThrow(/bid\/ask/);
  });

  it("rejects zero quantities", () => {
    expect(() => simulateLimitOrder({ ...order, quantity: "0" }, snapshot, { nowMs, maxSnapshotAgeMs: 1000 }))
      .toThrow();
  });
});
