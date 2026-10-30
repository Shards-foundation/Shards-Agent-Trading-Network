import { describe, expect, it } from "vitest";
import { simulateLimitOrder } from "../src/index.js";

const nowMs = 1_800_000_000_000;
const market = {
  venue: "fixture",
  instrumentId: "BTC-USD",
  observedAt: new Date(nowMs - 100).toISOString(),
  bid: "99",
  ask: "100",
  dataQuality: "LIVE",
};
const buy = {
  side: "BUY",
  quantity: "1",
  limitPrice: "100",
  feeBps: 10,
};
const options = { nowMs, maxSnapshotAgeMs: 1000 };

describe("paper execution negative and boundary cases", () => {
  it("rejects future snapshots and all non-live data qualities", () => {
    expect(() =>
      simulateLimitOrder(
        buy,
        { ...market, observedAt: new Date(nowMs + 1).toISOString() },
        options,
      ),
    ).toThrow(/fresh/);
    for (const dataQuality of ["DELAYED", "STALE", "UNKNOWN"]) {
      expect(() =>
        simulateLimitOrder(buy, { ...market, dataQuality }, options),
      ).toThrow(/fresh/);
    }
  });

  it("rejects invalid, zero and crossed-market book prices", () => {
    for (const book of [
      { bid: "0", ask: "100" },
      { bid: "99", ask: "0" },
      { bid: "101", ask: "100" },
    ]) {
      expect(() =>
        simulateLimitOrder(buy, { ...market, ...book }, options),
      ).toThrow();
    }
  });

  it("never fills a buy below the ask or a sell above the bid", () => {
    const noBuy = simulateLimitOrder(
      { ...buy, limitPrice: "99.99999999" },
      market,
      options,
    );
    const noSell = simulateLimitOrder(
      { ...buy, side: "SELL", limitPrice: "99.00000001" },
      market,
      options,
    );
    for (const result of [noBuy, noSell]) {
      expect(result).toMatchObject({
        mode: "PAPER",
        evidenceLabel: "SIMULATED",
        status: "NOT_FILLED",
        fillPrice: null,
        notional: "0",
        fee: "0",
      });
    }
  });

  it("enforces the maximum fee and zero-fee boundaries", () => {
    const noFee = simulateLimitOrder({ ...buy, feeBps: 0 }, market, options);
    expect(noFee.fee).toBe("0");
    const fullFee = simulateLimitOrder(
      { ...buy, feeBps: 10_000 },
      market,
      options,
    );
    expect(fullFee.fee).toBe(fullFee.notional);
    expect(() =>
      simulateLimitOrder({ ...buy, feeBps: 10_001 }, market, options),
    ).toThrow();
    expect(() =>
      simulateLimitOrder({ ...buy, feeBps: -1 }, market, options),
    ).toThrow();
  });

  it("rejects untrusted order properties rather than accepting execution flags", () => {
    expect(() =>
      simulateLimitOrder({ ...buy, mode: "LIVE_RESTRICTED" }, market, options),
    ).toThrow();
  });
});
