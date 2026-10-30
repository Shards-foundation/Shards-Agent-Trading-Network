const SCALE = 100_000_000n;

export interface PaperAccountingFill {
  instrument: string;
  side: "BUY" | "SELL";
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string;
  filledAt: string;
}

export interface InstrumentPerformance {
  instrument: string;
  fillCount: number;
  positionQuantity: string;
  averageEntryPrice: string | null;
  realizedGrossPnl: string;
  feesPaidUsd: string;
  netRealizedPnlLessAllUsdFees: string;
  closedQuantity: string;
  wins: number;
  losses: number;
}

export interface PaperPerformanceSummary {
  methodologyVersion: "paper-average-cost-v1";
  provenance: "SIMULATED";
  fillCount: number;
  instrumentCount: number;
  openPositionCount: number;
  realizedGrossPnl: string;
  feesPaidUsd: string;
  netRealizedPnlLessAllUsdFees: string;
  closedQuantity: string;
  wins: number;
  losses: number;
  qualityFlags: string[];
  instruments: InstrumentPerformance[];
}

interface MutableInstrument {
  instrument: string;
  fillCount: number;
  position: bigint;
  averageEntry: bigint;
  realizedGross: bigint;
  feesUsd: bigint;
  closedQuantity: bigint;
  wins: number;
  losses: number;
}

function toUnits(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Accounting decimals must be non-negative and have at most eight fractional digits.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "00000000").slice(0, 8));
}

function fromUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  const decimal = fraction.length ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${decimal}` : decimal;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Computes realised gross P&L using average-cost accounting for paper fills.
 * USD fees are deducted in the summary; unrealised P&L is deliberately excluded.
 * The result is simulated accounting evidence, not an exchange statement.
 */
export function calculatePaperPerformance(rawFills: readonly PaperAccountingFill[]): PaperPerformanceSummary {
  const fills = rawFills.map((fill, index) => {
    if (!fill.instrument.trim() || fill.instrument.length > 128) throw new Error("Invalid accounting instrument.");
    if (fill.side !== "BUY" && fill.side !== "SELL") throw new Error("Invalid accounting side.");
    if (!Number.isFinite(Date.parse(fill.filledAt))) throw new Error("Invalid fill timestamp.");
    return {
      ...fill,
      index,
      quantity: toUnits(fill.quantity),
      price: toUnits(fill.price),
      fee: toUnits(fill.fee),
      timestamp: Date.parse(fill.filledAt)
    };
  }).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  const states = new Map<string, MutableInstrument>();
  const qualityFlags = new Set<string>(["UNREALISED_PNL_EXCLUDED", "SIMULATED_EXECUTION_ONLY"]);

  for (const fill of fills) {
    if (fill.quantity <= 0n || fill.price <= 0n) throw new Error("Fill quantity and price must be positive.");
    if (fill.feeAsset !== "USD") qualityFlags.add("NON_USD_FEES_EXCLUDED");
    let state = states.get(fill.instrument);
    if (!state) {
      state = {
        instrument: fill.instrument,
        fillCount: 0,
        position: 0n,
        averageEntry: 0n,
        realizedGross: 0n,
        feesUsd: 0n,
        closedQuantity: 0n,
        wins: 0,
        losses: 0
      };
      states.set(fill.instrument, state);
    }

    state.fillCount += 1;
    if (fill.feeAsset === "USD") state.feesUsd += fill.fee;
    const signedQuantity = fill.side === "BUY" ? fill.quantity : -fill.quantity;
    const oldPosition = state.position;

    if (oldPosition === 0n || (oldPosition > 0n && signedQuantity > 0n) || (oldPosition < 0n && signedQuantity < 0n)) {
      const oldAbsolute = absolute(oldPosition);
      const addedAbsolute = absolute(signedQuantity);
      state.averageEntry = oldAbsolute + addedAbsolute === 0n
        ? 0n
        : (oldAbsolute * state.averageEntry + addedAbsolute * fill.price) / (oldAbsolute + addedAbsolute);
      state.position = oldPosition + signedQuantity;
      continue;
    }

    const closed = absolute(oldPosition) < absolute(signedQuantity) ? absolute(oldPosition) : absolute(signedQuantity);
    const perUnitPnl = oldPosition > 0n ? fill.price - state.averageEntry : state.averageEntry - fill.price;
    const realised = (perUnitPnl * closed) / SCALE;
    state.realizedGross += realised;
    state.closedQuantity += closed;
    if (realised > 0n) state.wins += 1;
    if (realised < 0n) state.losses += 1;

    const newPosition = oldPosition + signedQuantity;
    if (newPosition === 0n) {
      state.averageEntry = 0n;
    } else if ((newPosition > 0n) !== (oldPosition > 0n)) {
      // A reversal closes the prior position and opens the remainder at this fill price.
      state.averageEntry = fill.price;
    }
    state.position = newPosition;
  }

  const instruments: InstrumentPerformance[] = [...states.values()]
    .sort((a, b) => a.instrument.localeCompare(b.instrument))
    .map((state) => ({
      instrument: state.instrument,
      fillCount: state.fillCount,
      positionQuantity: fromUnits(state.position),
      averageEntryPrice: state.position === 0n ? null : fromUnits(state.averageEntry),
      realizedGrossPnl: fromUnits(state.realizedGross),
      feesPaidUsd: fromUnits(state.feesUsd),
      netRealizedPnlLessAllUsdFees: fromUnits(state.realizedGross - state.feesUsd),
      closedQuantity: fromUnits(state.closedQuantity),
      wins: state.wins,
      losses: state.losses
    }));

  const totals = [...states.values()].reduce((acc, state) => ({
    realizedGross: acc.realizedGross + state.realizedGross,
    feesUsd: acc.feesUsd + state.feesUsd,
    closedQuantity: acc.closedQuantity + state.closedQuantity,
    wins: acc.wins + state.wins,
    losses: acc.losses + state.losses
  }), { realizedGross: 0n, feesUsd: 0n, closedQuantity: 0n, wins: 0, losses: 0 });

  return {
    methodologyVersion: "paper-average-cost-v1",
    provenance: "SIMULATED",
    fillCount: fills.length,
    instrumentCount: states.size,
    openPositionCount: instruments.filter((instrument) => instrument.positionQuantity !== "0").length,
    realizedGrossPnl: fromUnits(totals.realizedGross),
    feesPaidUsd: fromUnits(totals.feesUsd),
    netRealizedPnlLessAllUsdFees: fromUnits(totals.realizedGross - totals.feesUsd),
    closedQuantity: fromUnits(totals.closedQuantity),
    wins: totals.wins,
    losses: totals.losses,
    qualityFlags: [...qualityFlags].sort(),
    instruments
  };
}
