import { describe, expect, it } from "vitest";
import { evaluateTradeIntent, TradeIntentSchema } from "../src/index.js";

const SCALE = 100_000_000n;

function decimal(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

// Stable seeded generation: no nondeterminism, no external property-test
// dependency, reproducible failures with seed and iteration in the message.
function generator(seed: number): () => number {
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
  quantity: "1",
  limitPrice: "1",
  mode: "PAPER" as const,
};

const policy = {
  allowedVenues: ["hyperliquid"],
  maxOrderNotional: "100",
  liveExecutionEnabled: false,
  halted: false,
  marketDataAgeMs: 100,
  maxMarketDataAgeMs: 1000,
  dailyLoss: "0",
  maxDailyLoss: "50",
};

describe("adversarial paper risk invariants", () => {
  it("evaluates exact decimal products against caps without a round-down bypass", () => {
    for (const seed of [1, 42, 20261030, 0xffffffff]) {
      const rand = generator(seed);
      for (let index = 0; index < 256; index += 1) {
        // Quantity/price span 1e-8 to a little over 10 units.
        const quantity = BigInt(1 + (rand() % 1_000_000_000));
        const price = BigInt(1 + (rand() % 1_000_000_000));
        const exactProduct = quantity * price;
        const floorCap = exactProduct / SCALE;
        const delta = BigInt(rand() % 3);
        const cap = floorCap > delta ? floorCap - delta : 0n;
        const result = evaluateTradeIntent(
          { ...intent, quantity: decimal(quantity), limitPrice: decimal(price) },
          { ...policy, maxOrderNotional: decimal(cap) },
          `seed-${seed}`,
        );
        const exceeds = exactProduct > cap * SCALE;
        expect(
          result.allowed,
          `seed=${seed} case=${index} exact=${exactProduct} cap=${cap}`,
        ).toBe(!exceeds);
        expect(result.reasons.includes("ORDER_NOTIONAL_EXCEEDED")).toBe(exceeds);
        const ceiling = (exactProduct + SCALE - 1n) / SCALE;
        expect(result.notional).toBe(decimal(ceiling));
        expect(result.policyVersion).toBe(`seed-${seed}`);
      }
    }
  });

  it("rejects oversized decimal inputs with typed validation rather than exceptions", () => {
    for (const value of [
      "9".repeat(21),
      "1".repeat(100_000),
      "0.000000001",
      "1e100",
      "-1",
      "NaN",
      "Infinity",
    ]) {
      expect(TradeIntentSchema.safeParse({ ...intent, quantity: value }).success).toBe(false);
      expect(TradeIntentSchema.safeParse({ ...intent, limitPrice: value }).success).toBe(false);
    }
  });

  it("cannot authorise non-paper intents through a caller-controlled policy flag", () => {
    for (const mode of ["LIVE_RESTRICTED", "READ_ONLY"] as const) {
      for (const enabled of [true, false]) {
        const result = evaluateTradeIntent(
          { ...intent, mode },
          { ...policy, liveExecutionEnabled: enabled },
          "paper-only-v1",
        );
        expect(result.allowed).toBe(false);
        expect(result.reasons).toContain("UNSUPPORTED_EXECUTION_MODE");
      }
    }
  });

  it("fails closed at stale-data and loss-limit boundaries", () => {
    const atFreshness = evaluateTradeIntent(
      intent,
      { ...policy, marketDataAgeMs: 1_000 },
      "policy-v1",
    );
    const pastFreshness = evaluateTradeIntent(
      intent,
      { ...policy, marketDataAgeMs: 1_001 },
      "policy-v1",
    );
    expect(atFreshness.allowed).toBe(true);
    expect(pastFreshness.reasons).toContain("STALE_MARKET_DATA");

    const atLoss = evaluateTradeIntent(
      intent,
      { ...policy, dailyLoss: "50" },
      "policy-v1",
    );
    expect(atLoss.reasons).toContain("DAILY_LOSS_LIMIT_REACHED");
  });
});
