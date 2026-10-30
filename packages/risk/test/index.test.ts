import { describe, expect, it } from "vitest";
import { evaluateTradeIntent, TradeIntentSchema } from "../src/index.js";

const intent = {
  venue: "hyperliquid",
  instrument: "BTC",
  side: "BUY",
  quantity: "0.001",
  orderType: "LIMIT",
  limitPrice: "50000",
  mode: "PAPER",
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

describe("deterministic risk gate", () => {
  it("allows a bounded paper intent and computes notional without floats", () => {
    expect(evaluateTradeIntent(intent, policy, "test-v1")).toEqual({
      allowed: true,
      reasons: [],
      notional: "50",
      policyVersion: "test-v1",
    });
  });

  it("rejects unknown intent properties", () => {
    expect(
      TradeIntentSchema.safeParse({ ...intent, withdrawAll: true }).success,
    ).toBe(false);
  });

  it("rejects zero quantities and zero limit prices", () => {
    expect(
      TradeIntentSchema.safeParse({ ...intent, quantity: "0.00000000" })
        .success,
    ).toBe(false);
    expect(
      TradeIntentSchema.safeParse({ ...intent, limitPrice: "0.000" }).success,
    ).toBe(false);
  });

  it("bounds untrusted decimal inputs to the database's integer capacity", () => {
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        quantity: "123456789012345678901",
      }).success,
    ).toBe(false);
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        limitPrice: "123456789012345678901",
      }).success,
    ).toBe(false);
    expect(
      TradeIntentSchema.safeParse({
        ...intent,
        quantity: "12345678901234567890",
      }).success,
    ).toBe(true);
  });

  it("rejects a venue not explicitly allowlisted", () => {
    const decision = evaluateTradeIntent(
      { ...intent, venue: "unknown" },
      policy,
      "v1",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("VENUE_NOT_ALLOWED");
  });

  it("fails closed when the policy is halted", () => {
    const decision = evaluateTradeIntent(
      intent,
      { ...policy, halted: true },
      "v1",
    );
    expect(decision.reasons).toContain("POLICY_HALTED");
  });

  it("rejects stale market data", () => {
    const decision = evaluateTradeIntent(
      intent,
      { ...policy, marketDataAgeMs: 1001 },
      "v1",
    );
    expect(decision.reasons).toContain("STALE_MARKET_DATA");
  });

  it("blocks live intents unless explicitly enabled", () => {
    const decision = evaluateTradeIntent(
      { ...intent, mode: "LIVE_RESTRICTED" },
      policy,
      "v1",
    );
    expect(decision.reasons).toContain("LIVE_EXECUTION_DISABLED");
    expect(decision.reasons).toContain("UNSUPPORTED_EXECUTION_MODE");
  });

  it("never approves non-paper modes even if a policy flag is set", () => {
    for (const mode of ["LIVE_RESTRICTED", "READ_ONLY"]) {
      const decision = evaluateTradeIntent(
        { ...intent, mode },
        { ...policy, liveExecutionEnabled: true },
        "v1",
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reasons).toContain("UNSUPPORTED_EXECUTION_MODE");
    }
  });

  it("enforces order notional limit", () => {
    const decision = evaluateTradeIntent(
      { ...intent, quantity: "0.01" },
      policy,
      "v1",
    );
    expect(decision.reasons).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("never rounds down a positive exposure below a zero cap", () => {
    const decision = evaluateTradeIntent(
      { ...intent, quantity: "0.00000001", limitPrice: "0.00000001" },
      { ...policy, maxOrderNotional: "0" },
      "paper-v1",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.notional).toBe("0.00000001");
    expect(decision.reasons).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("rejects fractional overflow above a very small exact cap", () => {
    const decision = evaluateTradeIntent(
      { ...intent, quantity: "1.00000001", limitPrice: "0.00000001" },
      { ...policy, maxOrderNotional: "0.00000001" },
      "paper-v1",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.notional).toBe("0.00000002");
    expect(decision.reasons).toContain("ORDER_NOTIONAL_EXCEEDED");
  });

  it("still permits a notional exactly equal to the cap", () => {
    const decision = evaluateTradeIntent(
      { ...intent, quantity: "0.00000001", limitPrice: "1" },
      { ...policy, maxOrderNotional: "0.00000001" },
      "paper-v1",
    );
    expect(decision.allowed).toBe(true);
    expect(decision.notional).toBe("0.00000001");
  });

  it("blocks at the daily loss threshold", () => {
    const decision = evaluateTradeIntent(
      intent,
      { ...policy, dailyLoss: "50" },
      "v1",
    );
    expect(decision.reasons).toContain("DAILY_LOSS_LIMIT_REACHED");
  });

  it("does not silently accept market orders without a reference price", () => {
    const decision = evaluateTradeIntent(
      { ...intent, orderType: "MARKET", limitPrice: undefined },
      policy,
      "v1",
    );
    expect(decision.reasons).toContain("MARKET_ORDER_REQUIRES_REFERENCE_PRICE");
  });
});
