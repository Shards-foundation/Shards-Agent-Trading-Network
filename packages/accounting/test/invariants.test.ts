import { describe, expect, it } from "vitest";
import {
  calculatePaperDailyLoss,
  calculatePaperPerformance,
  type PaperAccountingFill,
} from "../src/index.js";

const baseTime = "2026-10-30T12:00:00.000Z";
const closeTime = "2026-10-30T12:01:00.000Z";
const dayStart = "2026-10-30T00:00:00.000Z";

function fill(
  side: "BUY" | "SELL",
  quantity: number,
  price: number,
  filledAt: string,
  instrument = "BTC",
): PaperAccountingFill {
  return {
    instrument,
    side,
    quantity: String(quantity),
    price: String(price),
    fee: "0",
    feeAsset: "USD",
    filledAt,
  };
}

describe("accounting metamorphic and adversarial invariants", () => {
  it("a matched buy/sell cycle has zero remaining position and exact integer profit", () => {
    for (let i = 0; i < 200; i += 1) {
      const quantity = 1 + (i % 17);
      const open = 50 + (i % 101);
      const close = 40 + ((i * 37) % 173);
      const fills = [
        fill("BUY", quantity, open, baseTime),
        fill("SELL", quantity, close, closeTime),
      ];
      const actual = calculatePaperPerformance(fills);
      const expected = (close - open) * quantity;
      expect(actual.realizedGrossPnl, `case ${i}`).toBe(String(expected));
      expect(actual.netRealizedPnlLessAllUsdFees).toBe(String(expected));
      expect(actual.openPositionCount).toBe(0);
      expect(actual.instruments[0]?.positionQuantity).toBe("0");
      expect(actual.instruments[0]?.averageEntryPrice).toBeNull();
      const daily = calculatePaperDailyLoss(fills, dayStart);
      expect(daily.dailyNetPnl).toBe(String(expected));
      expect(daily.dailyLoss).toBe(String(Math.max(0, -expected)));
    }
  });

  it("a matched short cover has the opposite exact sign and no remaining exposure", () => {
    for (let i = 0; i < 120; i += 1) {
      const quantity = 1 + (i % 13);
      const open = 60 + (i % 91);
      const close = 40 + ((i * 23) % 153);
      const actual = calculatePaperPerformance([
        fill("SELL", quantity, open, baseTime),
        fill("BUY", quantity, close, closeTime),
      ]);
      expect(actual.realizedGrossPnl, `case ${i}`).toBe(
        String((open - close) * quantity),
      );
      expect(actual.openPositionCount).toBe(0);
      expect(actual.instruments[0]?.positionQuantity).toBe("0");
    }
  });

  it("separately labelled instruments cannot contaminate one another's P&L", () => {
    const btc = [
      fill("BUY", 2, 100, baseTime, "BTC"),
      fill("SELL", 2, 120, closeTime, "BTC"),
    ];
    const eth = [
      fill("SELL", 3, 200, baseTime, "ETH"),
      fill("BUY", 3, 190, closeTime, "ETH"),
    ];
    const first = calculatePaperPerformance([...btc, ...eth]);
    const second = calculatePaperPerformance([...eth, ...btc]);
    expect(first.realizedGrossPnl).toBe("70");
    expect(second.realizedGrossPnl).toBe(first.realizedGrossPnl);
    expect(second.instruments).toEqual(first.instruments);
    expect(first.openPositionCount).toBe(0);
  });

  it("refuses invalid and nonfinite fill data rather than silently producing profit", () => {
    const valid = fill("BUY", 1, 100, baseTime);
    for (const [key, value] of [
      ["quantity", "-1"],
      ["quantity", "1e99"],
      ["quantity", "Infinity"],
      ["price", "NaN"],
      ["fee", "-0.1"],
      ["filledAt", "invalid-time"],
      ["instrument", ""],
    ] as const) {
      expect(() =>
        calculatePaperPerformance([{ ...valid, [key]: value }]),
      ).toThrow();
    }
  });
});
