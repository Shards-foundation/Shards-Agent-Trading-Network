import { z } from "zod";

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/);
const PaperOrderSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  quantity: decimal,
  limitPrice: decimal,
  feeBps: z.number().int().min(0).max(10_000)
}).strict().superRefine((order, ctx) => {
  if (toUnits(order.quantity) === 0n) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must be positive" });
  }
  if (toUnits(order.limitPrice) === 0n) {
    ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "limitPrice must be positive" });
  }
});

const SnapshotSchema = z.object({
  venue: z.string().min(1),
  instrumentId: z.string().min(1),
  observedAt: z.string().datetime(),
  bid: decimal,
  ask: decimal,
  dataQuality: z.enum(["LIVE", "DELAYED", "STALE", "UNKNOWN"])
}).strict();

export interface PaperFillResult {
  mode: "PAPER";
  status: "FILLED" | "NOT_FILLED";
  side: "BUY" | "SELL";
  quantity: string;
  fillPrice: string | null;
  notional: string;
  fee: string;
  feeBps: number;
  venue: string;
  instrumentId: string;
  simulatedAt: string;
  evidenceLabel: "SIMULATED";
  reason: "LIMIT_CROSSED" | "LIMIT_NOT_CROSSED";
}

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

/**
 * Deterministic, deliberately simple paper fill model.
 * It is not a market-impact simulator and must never be labelled as live execution.
 */
export function simulateLimitOrder(
  rawOrder: unknown,
  rawSnapshot: unknown,
  options: { nowMs: number; maxSnapshotAgeMs: number }
): PaperFillResult {
  const order = PaperOrderSchema.parse(rawOrder);
  const snapshot = SnapshotSchema.parse(rawSnapshot);
  const observedMs = Date.parse(snapshot.observedAt);

  if (snapshot.dataQuality !== "LIVE" || !Number.isFinite(observedMs) ||
      observedMs > options.nowMs || options.nowMs - observedMs > options.maxSnapshotAgeMs) {
    throw new Error("Paper execution requires a fresh, known-quality market snapshot.");
  }

  const bid = toUnits(snapshot.bid);
  const ask = toUnits(snapshot.ask);
  if (bid <= 0n || ask <= 0n || ask < bid) {
    throw new Error("Market snapshot has invalid bid/ask values.");
  }

  const limit = toUnits(order.limitPrice);
  const quantity = toUnits(order.quantity);
  const fillPrice = order.side === "BUY"
    ? (ask <= limit ? ask : null)
    : (bid >= limit ? bid : null);
  const filled = fillPrice !== null;
  const notionalUnits = filled ? (fillPrice * quantity) / 100_000_000n : 0n;
  const feeUnits = (notionalUnits * BigInt(order.feeBps)) / 10_000n;

  return {
    mode: "PAPER",
    status: filled ? "FILLED" : "NOT_FILLED",
    side: order.side,
    quantity: order.quantity,
    fillPrice: fillPrice === null ? null : fromUnits(fillPrice),
    notional: fromUnits(notionalUnits),
    fee: fromUnits(feeUnits),
    feeBps: order.feeBps,
    venue: snapshot.venue,
    instrumentId: snapshot.instrumentId,
    simulatedAt: new Date(options.nowMs).toISOString(),
    evidenceLabel: "SIMULATED",
    reason: filled ? "LIMIT_CROSSED" : "LIMIT_NOT_CROSSED"
  };
}
