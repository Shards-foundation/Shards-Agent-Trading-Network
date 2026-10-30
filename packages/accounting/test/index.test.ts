import { describe, expect, it } from "vitest";
import { calculatePaperDailyLoss, calculatePaperPerformance, type PaperAccountingFill } from "../src/index.js";

const fill = (overrides: Partial<PaperAccountingFill> = {}): PaperAccountingFill => ({
  instrument: "BTC",
  side: "BUY",
  quantity: "2",
  price: "100",
  fee: "0.2",
  feeAsset: "USD",
  filledAt: "2026-10-30T12:00:00.000Z",
  ...overrides
});

describe("paper average-cost accounting", () => {
  it("calculates realised gross P&L, fees and remaining position with integer arithmetic", () => {
    const result = calculatePaperPerformance([
      fill(),
      fill({ side: "SELL", quantity: "1", price: "110", fee: "0.11", filledAt: "2026-10-30T12:01:00.000Z" })
    ]);
    expect(result).toMatchObject({
      methodologyVersion: "paper-average-cost-v1",
      provenance: "SIMULATED",
      hasData: true,
      fillCount: 2,
      openPositionCount: 1,
      realizedGrossPnl: "10",
      feesPaidUsd: "0.31",
      netRealizedPnlLessAllUsdFees: "9.69",
      profitableCloseEvents: 1,
      unprofitableCloseEvents: 0,
      qualityFlags: ["SIMULATED_EXECUTION_ONLY", "UNREALISED_PNL_EXCLUDED"]
    });
    expect(result.instruments[0]).toMatchObject({
      instrument: "BTC",
      positionQuantity: "1",
      averageEntryPrice: "100",
      realizedGrossPnl: "10",
      feesPaidUsd: "0.31"
    });
  });

  it("accounts for a short position closing profitably", () => {
    const result = calculatePaperPerformance([
      fill({ side: "SELL", quantity: "2", price: "100", fee: "0.2" }),
      fill({ side: "BUY", quantity: "1", price: "90", fee: "0.09", filledAt: "2026-10-30T12:01:00.000Z" })
    ]);
    expect(result.realizedGrossPnl).toBe("10");
    expect(result.instruments[0]).toMatchObject({
      positionQuantity: "-1",
      averageEntryPrice: "100",
      closedQuantity: "1",
      profitableCloseEvents: 1
    });
  });

  it("resets average cost at a position reversal", () => {
    const result = calculatePaperPerformance([
      fill({ side: "BUY", quantity: "1", price: "100", fee: "0" }),
      fill({ side: "SELL", quantity: "2", price: "110", fee: "0", filledAt: "2026-10-30T12:01:00.000Z" })
    ]);
    expect(result.realizedGrossPnl).toBe("10");
    expect(result.instruments[0]).toMatchObject({ positionQuantity: "-1", averageEntryPrice: "110" });
  });

  it("orders fills by timestamp instead of trusting caller ordering", () => {
    const result = calculatePaperPerformance([
      fill({ side: "SELL", quantity: "1", price: "110", fee: "0", filledAt: "2026-10-30T12:01:00.000Z" }),
      fill({ side: "BUY", quantity: "1", price: "100", fee: "0", filledAt: "2026-10-30T12:00:00.000Z" })
    ]);
    expect(result.realizedGrossPnl).toBe("10");
    expect(result.openPositionCount).toBe(0);
  });

  it("excludes non-USD fees from USD totals and flags the limitation", () => {
    const result = calculatePaperPerformance([fill({ feeAsset: "ETH" })]);
    expect(result.feesPaidUsd).toBe("0");
    expect(result.qualityFlags).toContain("NON_USD_FEES_EXCLUDED");
  });

  it("rejects invalid decimals and timestamps", () => {
    expect(() => calculatePaperPerformance([fill({ quantity: "-1" })])).toThrow();
    expect(() => calculatePaperPerformance([fill({ filledAt: "not-a-date" })])).toThrow();
  });

  it("computes UTC-day loss using prior-day average-cost basis and daily fees", () => {
    const result = calculatePaperDailyLoss([
      fill({ quantity: "2", price: "100", fee: "0", filledAt: "2026-10-29T23:00:00.000Z" }),
      fill({ side: "SELL", quantity: "1", price: "90", fee: "0.1", filledAt: "2026-10-30T01:00:00.000Z" })
    ], "2026-10-30T00:00:00.000Z");
    expect(result).toEqual({ dailyNetPnl: "-10.1", dailyLoss: "10.1" });
  });

  it("does not count prior-day realised losses in today's loss", () => {
    const result = calculatePaperDailyLoss([
      fill({ quantity: "1", price: "100", fee: "0", filledAt: "2026-10-29T12:00:00.000Z" }),
      fill({ side: "SELL", quantity: "1", price: "80", fee: "0", filledAt: "2026-10-29T13:00:00.000Z" })
    ], "2026-10-30T00:00:00.000Z");
    expect(result).toEqual({ dailyNetPnl: "0", dailyLoss: "0" });
  });

  it("treats daily USD fees as loss and ignores non-USD fees without conversion", () => {
    const result = calculatePaperDailyLoss([
      fill({ fee: "1", feeAsset: "USD" }),
      fill({ fee: "5", feeAsset: "ETH" })
    ], "2026-10-30T00:00:00.000Z");
    expect(result).toEqual({ dailyNetPnl: "-1", dailyLoss: "1" });
  });

  it("handles an empty ledger without inventing performance", () => {
    expect(calculatePaperPerformance([])).toMatchObject({
      hasData: false,
      fillCount: 0,
      instrumentCount: 0,
      openPositionCount: 0,
      realizedGrossPnl: "0",
      feesPaidUsd: "0",
      netRealizedPnlLessAllUsdFees: "0",
      qualityFlags: ["SIMULATED_EXECUTION_ONLY", "UNREALISED_PNL_EXCLUDED"],
      instruments: []
    });
  });
});
