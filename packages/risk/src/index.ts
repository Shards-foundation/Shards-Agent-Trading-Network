import { z } from "zod";

export const TradeIntentSchema = z.object({
  venue: z.string().min(1).max(64),
  instrument: z.string().min(1).max(128),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  orderType: z.enum(["MARKET", "LIMIT"]),
  limitPrice: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/).optional(),
  mode: z.enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED"])
}).strict().superRefine((value, ctx) => {
  if (toUnits(value.quantity) === 0n) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must be greater than zero." });
  }
  if (value.orderType === "LIMIT" && value.limitPrice === undefined) {
    ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "LIMIT orders require limitPrice." });
  }
  if (value.limitPrice !== undefined && toUnits(value.limitPrice) === 0n) {
    ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "limitPrice must be greater than zero." });
  }
});

export type TradeIntent = z.infer<typeof TradeIntentSchema>;

export const RiskPolicySchema = z.object({
  allowedVenues: z.array(z.string().min(1)).min(1),
  maxOrderNotional: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/),
  liveExecutionEnabled: z.boolean().default(false),
  halted: z.boolean().default(false),
  marketDataAgeMs: z.number().int().nonnegative(),
  maxMarketDataAgeMs: z.number().int().positive(),
  dailyLoss: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/).default("0"),
  maxDailyLoss: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/)
}).strict();

export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export type RiskReason =
  | "POLICY_HALTED"
  | "VENUE_NOT_ALLOWED"
  | "STALE_MARKET_DATA"
  | "LIVE_EXECUTION_DISABLED"
  | "MARKET_ORDER_REQUIRES_REFERENCE_PRICE"
  | "ORDER_NOTIONAL_EXCEEDED"
  | "DAILY_LOSS_LIMIT_REACHED";

export interface RiskDecision {
  allowed: boolean;
  reasons: RiskReason[];
  notional?: string;
  policyVersion: string;
}

/**
 * Converts a non-negative decimal string to integer units at 1e-8 precision.
 * No floating-point arithmetic is used for risk calculations.
 */
function toUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Invalid decimal value");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100_000_000n + BigInt((fraction + "00000000").slice(0, 8));
}

function fromUnits(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction.length ? `${whole}.${fraction}` : whole.toString();
}

export function evaluateTradeIntent(
  rawIntent: unknown,
  rawPolicy: unknown,
  policyVersion: string
): RiskDecision {
  const intent = TradeIntentSchema.parse(rawIntent);
  const policy = RiskPolicySchema.parse(rawPolicy);
  const reasons: RiskReason[] = [];

  if (policy.halted) reasons.push("POLICY_HALTED");
  if (!policy.allowedVenues.includes(intent.venue)) reasons.push("VENUE_NOT_ALLOWED");
  if (policy.marketDataAgeMs > policy.maxMarketDataAgeMs) reasons.push("STALE_MARKET_DATA");
  if (intent.mode === "LIVE_RESTRICTED" && !policy.liveExecutionEnabled) {
    reasons.push("LIVE_EXECUTION_DISABLED");
  }
  if (toUnits(policy.dailyLoss) >= toUnits(policy.maxDailyLoss)) {
    reasons.push("DAILY_LOSS_LIMIT_REACHED");
  }

  let notional: string | undefined;
  const referencePrice = intent.orderType === "LIMIT" ? intent.limitPrice : undefined;
  if (referencePrice === undefined) {
    reasons.push("MARKET_ORDER_REQUIRES_REFERENCE_PRICE");
  } else {
    const computed = (toUnits(referencePrice) * toUnits(intent.quantity)) / 100_000_000n;
    notional = fromUnits(computed);
    if (computed > toUnits(policy.maxOrderNotional)) reasons.push("ORDER_NOTIONAL_EXCEEDED");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    ...(notional === undefined ? {} : { notional }),
    policyVersion
  };
}
