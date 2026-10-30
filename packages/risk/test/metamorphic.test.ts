import { describe, expect, it } from "vitest";
import { evaluateTradeIntent } from "../src/index.js";

const SCALE = 100_000_000n;

function asDecimal(units: bigint): string {
  const whole = units / SCALE;
  const fraction = (units % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const intent = {
  venue: "hyperliquid",
  instrument: "BTC",
  side: "BUY" as const,
  orderType: "LIMIT" as const,
  mode: "PAPER" as const,
  quantity: "1",
  limitPrice: "1",
};

const policy = {
  allowedVenues: ["hyperliquid"],
  maxOrderNotional: "100",
  halted: false,
  liveExecutionEnabled: false,
  marketDataAgeMs: 0,
  maxMarketDataAgeMs: 1000,
  dailyLoss: "0",
  maxDailyLoss: "100",
};

describe("risk-engine metamorphic and boundary regressions", () => {
  it("never permits a greater quantity when the original order exceeds its notional cap", () => {
    const rand = rng(0x51a7babe);
    for (let i = 0; i < 512; i += 1) {
      const quantity = BigInt(1 + (rand() % 100_000_000));
      const price = BigInt(1 + (rand() % 100_000_000));
      const cap = BigInt(rand() % 100_000_000);
      const original = evaluateTradeIntent(
        { ...intent, quantity: asDecimal(quantity), limitPrice: asDecimal(price) },
        { ...policy, maxOrderNotional: asDecimal(cap) },
        "metamorphic-v1",
      );
      const larger = evaluateTradeIntent(
        { ...intent, quantity: asDecimal(quantity + 1n), limitPrice: asDecimal(price) },
        { ...policy, maxOrderNotional: asDecimal(cap) },
        "metamorphic-v1",
      );
      if (original.reasons.includes("ORDER_NOTIONAL_EXCEEDED")) {
        expect(larger.reasons, `iteration=${i}`).toContain("ORDER_NOTIONAL_EXCEEDED");
      }
    }
  });

  it("never permits a higher price when the original order exceeds its cap", () => {
    const rand = rng(0x2ca7e);
    for (let i = 0; i < 512; i += 1) {
      const quantity = BigInt(1 + (rand() % 100_000_000));
      const price = BigInt(1 + (rand() % 100_000_000));
      const cap = BigInt(rand() % 100_000_000);
      const original = evaluateTradeIntent(
        { ...intent, quantity: asDecimal(quantity), limitPrice: asDecimal(price) },
        { ...policy, maxOrderNotional: asDecimal(cap) },
        "metamorphic-v1",
      );
      const higher = evaluateTradeIntent(
        { ...intent, quantity: asDecimal(quantity), limitPrice: asDecimal(price + 1n) },
        { ...policy, maxOrderNotional: asDecimal(cap) },
        "metamorphic-v1",
      );
      if (original.reasons.includes("ORDER_NOTIONAL_EXCEEDED")) {
        expect(higher.reasons, `iteration=${i}`).toContain("ORDER_NOTIONAL_EXCEEDED");
      }
    }
  });

  it("never allows a halted policy regardless of a favourable price, cap or venue", () => {
    for (const price of ["0.00000001", "1", "99999999999999999999"]) {
      const decision = evaluateTradeIntent(
        { ...intent, limitPrice: price },
        { ...policy, halted: true, maxOrderNotional: "99999999999999999999" },
        "halted-v1",
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain("POLICY_HALTED");
    }
  });

  it("rejects a policy loss boundary even if the order notional is tiny", () => {
    for (const dailyLoss of ["1", "1.00000001", "99999999999999999999"]) {
      const decision = evaluateTradeIntent(
        { ...intent, quantity: "0.00000001", limitPrice: "0.00000001" },
        { ...policy, dailyLoss, maxDailyLoss: "1" },
        "loss-v1",
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain("DAILY_LOSS_LIMIT_REACHED");
    }
  });

  it("preserves a monotonic stale-market-data denial", () => {
    for (const age of [1001, 30000, 1_000_000_000]) {
      const decision = evaluateTradeIntent(
        intent,
        { ...policy, marketDataAgeMs: age },
        "freshness-v1",
      );
      expect(decision.reasons).toContain("STALE_MARKET_DATA");
    }
  });

  it("never approves a non-paper mode with caller-controlled liveEnabled", () => {
    for (const mode of ["READ_ONLY", "LIVE_RESTRICTED"] as const) {
      for (const enabled of [true, false]) {
        const decision = evaluateTradeIntent(
          { ...intent, mode },
          { ...policy, liveExecutionEnabled: enabled },
          "execution-v1",
        );
        expect(decision.allowed).toBe(false);
        expect(decision.reasons).toContain("UNSUPPORTED_EXECUTION_MODE");
      }
    }
  });
});
