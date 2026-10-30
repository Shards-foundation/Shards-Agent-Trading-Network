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
  profitableCloseEvents: number;
  unprofitableCloseEvents: number;
}

export interface PaperPerformanceSummary {
  methodologyVersion: "paper-average-cost-v1";
  provenance: "SIMULATED";
  hasData: boolean;
  fillCount: number;
  instrumentCount: number;
  openPositionCount: number;
  realizedGrossPnl: string;
  feesPaidUsd: string;
  netRealizedPnlLessAllUsdFees: string;
  profitableCloseEvents: number;
  unprofitableCloseEvents: number;
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
  profitableCloseEvents: number;
  unprofitableCloseEvents: number;
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

export interface PaperDailyLossResult {
  /** Net realised P&L for fills on or after the UTC day boundary, including USD fees. */
  dailyNetPnl: string;
  /** Non-negative loss amount derived from dailyNetPnl. */
  dailyLoss: string;
}

/**
 * Computes UTC-day realised net P&L while replaying the full fill history to
 * preserve average-cost basis for positions opened before the day boundary.
 * Non-USD fees are excluded because no conversion source is available.
 */
export function calculatePaperDailyLoss(
  rawFills: readonly PaperAccountingFill[],
  utcDayStart: string
): PaperDailyLossResult {
  const boundary = Date.parse(utcDayStart);
  if (!Number.isFinite(boundary) || new Date(boundary).toISOString() !== utcDayStart) {
    throw new Error("utcDayStart must be a canonical ISO timestamp.");
  }
  const fills = rawFills.map((fill, index) => {
    if (!fill.instrument.trim() || fill.instrument.length > 128) throw new Error("Invalid accounting instrument.");
    if (fill.side !== "BUY" && fill.side !== "SELL") throw new Error("Invalid accounting side.");
    if (!Number.isFinite(Date.parse(fill.filledAt))) throw new Error("Invalid fill timestamp.");
    const quantity = toUnits(fill.quantity);
    const price = toUnits(fill.price);
    const fee = toUnits(fill.fee);
    if (quantity <= 0n || price <= 0n) throw new Error("Fill quantity and price must be positive.");
    return { ...fill, index, quantity, price, fee, timestamp: Date.parse(fill.filledAt) };
  }).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  const states = new Map<string, { position: bigint; averageEntry: bigint }>();
  let dailyRealized = 0n;
  let dailyUsdFees = 0n;
  for (const fill of fills) {
    let state = states.get(fill.instrument);
    if (!state) {
      state = { position: 0n, averageEntry: 0n };
      states.set(fill.instrument, state);
    }
    const inWindow = fill.timestamp >= boundary;
    if (inWindow && fill.feeAsset === "USD") dailyUsdFees += fill.fee;
    const signed = fill.side === "BUY" ? fill.quantity : -fill.quantity;
    const oldPosition = state.position;
    if (oldPosition === 0n || (oldPosition > 0n && signed > 0n) || (oldPosition < 0n && signed < 0n)) {
      const oldAbs = absolute(oldPosition);
      const addedAbs = absolute(signed);
      state.averageEntry = oldAbs + addedAbs === 0n ? 0n :
        (oldAbs * state.averageEntry + addedAbs * fill.price) / (oldAbs + addedAbs);
      state.position = oldPosition + signed;
      continue;
    }
    const closed = absolute(oldPosition) < absolute(signed) ? absolute(oldPosition) : absolute(signed);
    if (inWindow) {
      const perUnitPnl = oldPosition > 0n ? fill.price - state.averageEntry : state.averageEntry - fill.price;
      dailyRealized += (perUnitPnl * closed) / SCALE;
    }
    const newPosition = oldPosition + signed;
    if (newPosition === 0n) state.averageEntry = 0n;
    else if ((newPosition > 0n) !== (oldPosition > 0n)) state.averageEntry = fill.price;
    state.position = newPosition;
  }
  const net = dailyRealized - dailyUsdFees;
  return { dailyNetPnl: fromUnits(net), dailyLoss: fromUnits(net < 0n ? -net : 0n) };
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
        profitableCloseEvents: 0,
        unprofitableCloseEvents: 0
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
    if (realised > 0n) state.profitableCloseEvents += 1;
    if (realised < 0n) state.unprofitableCloseEvents += 1;

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
      profitableCloseEvents: state.profitableCloseEvents,
      unprofitableCloseEvents: state.unprofitableCloseEvents
    }));

  const totals = [...states.values()].reduce((acc, state) => ({
    realizedGross: acc.realizedGross + state.realizedGross,
    feesUsd: acc.feesUsd + state.feesUsd,
    profitableCloseEvents: acc.profitableCloseEvents + state.profitableCloseEvents,
    unprofitableCloseEvents: acc.unprofitableCloseEvents + state.unprofitableCloseEvents
  }), { realizedGross: 0n, feesUsd: 0n, profitableCloseEvents: 0, unprofitableCloseEvents: 0 });

  return {
    methodologyVersion: "paper-average-cost-v1",
    provenance: "SIMULATED",
    hasData: fills.length > 0,
    fillCount: fills.length,
    instrumentCount: states.size,
    openPositionCount: instruments.filter((instrument) => instrument.positionQuantity !== "0").length,
    realizedGrossPnl: fromUnits(totals.realizedGross),
    feesPaidUsd: fromUnits(totals.feesUsd),
    netRealizedPnlLessAllUsdFees: fromUnits(totals.realizedGross - totals.feesUsd),
    profitableCloseEvents: totals.profitableCloseEvents,
    unprofitableCloseEvents: totals.unprofitableCloseEvents,
    qualityFlags: [...qualityFlags].sort(),
    instruments
  };
}


export interface PaperPortfolioMark {
  bid: string;
  ask: string;
}

export interface PaperPortfolioPosition {
  instrument: string;
  positionQuantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  grossExposureUsd: string | null;
  unrealizedGrossPnlUsd: string | null;
  realizedGrossPnlUsd: string;
  feesPaidUsd: string;
}

export interface PaperPortfolioSummary {
  methodologyVersion: "paper-average-cost-mtm-v1";
  provenance: "SIMULATED";
  hasData: boolean;
  hasCompleteMarks: boolean;
  fillCount: number;
  openPositionCount: number;
  pricedPositionCount: number;
  unpricedPositionCount: number;
  realizedGrossPnlUsd: string;
  unrealizedGrossPnlUsd: string;
  feesPaidUsd: string;
  netPnlLessAllUsdFees: string;
  totalGrossExposureUsd: string;
  qualityFlags: string[];
  positions: PaperPortfolioPosition[];
}

function toSignedUnits(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) {
    throw new Error("Signed accounting decimals must have at most eight fractional digits.");
  }
  return value.startsWith("-") ? -toUnits(value.slice(1)) : toUnits(value);
}

/**
 * Computes mark-to-market paper positions using integer fixed-point arithmetic.
 * Missing marks are reported as unpriced; aggregate P&L is partial when marks are incomplete.
 * The output is simulated accounting evidence, not an exchange statement or account equity.
 */
export function calculatePaperPortfolio(
  rawFills: readonly PaperAccountingFill[],
  marks: Readonly<Record<string, PaperPortfolioMark | undefined>>
): PaperPortfolioSummary {
  const performance = calculatePaperPerformance(rawFills);
  const qualityFlags = new Set(performance.qualityFlags.filter((flag) => flag !== "UNREALISED_PNL_EXCLUDED"));
  qualityFlags.add("MARK_TO_MARKET_INCLUDED");
  const positions: PaperPortfolioPosition[] = [];
  let unrealizedGross = 0n;
  let grossExposure = 0n;
  let pricedPositionCount = 0;
  let unpricedPositionCount = 0;

  for (const instrument of performance.instruments) {
    if (instrument.positionQuantity === "0" || instrument.averageEntryPrice === null) continue;
    const quantity = toSignedUnits(instrument.positionQuantity);
    const averageEntry = toUnits(instrument.averageEntryPrice);
    const mark = marks[instrument.instrument];
    let markPrice: string | null = null;
    let exposure: string | null = null;
    let unrealized: string | null = null;

    if (mark) {
      const bid = toUnits(mark.bid);
      const ask = toUnits(mark.ask);
      if (bid <= 0n || ask <= 0n || ask < bid) {
        throw new Error("Portfolio marks require positive bid/ask prices with ask greater than or equal to bid.");
      }
      const midpoint = (bid + ask) / 2n;
      const positionUnrealized = ((midpoint - averageEntry) * quantity) / SCALE;
      const positionExposure = (absolute(quantity) * midpoint) / SCALE;
      markPrice = fromUnits(midpoint);
      exposure = fromUnits(positionExposure);
      unrealized = fromUnits(positionUnrealized);
      unrealizedGross += positionUnrealized;
      grossExposure += positionExposure;
      pricedPositionCount += 1;
    } else {
      unpricedPositionCount += 1;
    }

    positions.push({
      instrument: instrument.instrument,
      positionQuantity: instrument.positionQuantity,
      averageEntryPrice: instrument.averageEntryPrice,
      markPrice,
      grossExposureUsd: exposure,
      unrealizedGrossPnlUsd: unrealized,
      realizedGrossPnlUsd: instrument.realizedGrossPnl,
      feesPaidUsd: instrument.feesPaidUsd
    });
  }

  if (unpricedPositionCount > 0) qualityFlags.add("UNPRICED_POSITIONS");
  if (unpricedPositionCount > 0) qualityFlags.add("PARTIAL_MARK_TO_MARKET");
  const realizedGross = toSignedUnits(performance.realizedGrossPnl);
  const feesUsd = toUnits(performance.feesPaidUsd);

  return {
    methodologyVersion: "paper-average-cost-mtm-v1",
    provenance: "SIMULATED",
    hasData: performance.hasData,
    hasCompleteMarks: unpricedPositionCount === 0,
    fillCount: performance.fillCount,
    openPositionCount: positions.length,
    pricedPositionCount,
    unpricedPositionCount,
    realizedGrossPnlUsd: fromUnits(realizedGross),
    unrealizedGrossPnlUsd: fromUnits(unrealizedGross),
    feesPaidUsd: fromUnits(feesUsd),
    netPnlLessAllUsdFees: fromUnits(realizedGross + unrealizedGross - feesUsd),
    totalGrossExposureUsd: fromUnits(grossExposure),
    qualityFlags: [...qualityFlags].sort(),
    positions
  };
}
