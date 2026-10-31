import { describe, expect, it } from "vitest";
import {
  parseHyperliquidAccount,
  parseHyperliquidOpenOrders,
} from "../app/api/venues/hyperliquid/account/route";

describe("Hyperliquid public account inspector", () => {
  const state = {
    marginSummary: {
      accountValue: "350.52",
      totalMarginUsed: "48.25",
      totalNtlPos: "255.0",
    },
    assetPositions: [
      {
        type: "oneWay",
        position: {
          coin: "BTC",
          szi: "-0.005",
          entryPx: "50000",
          positionValue: "250",
          unrealizedPnl: "-1.2",
          liquidationPx: "70000",
          leverage: { type: "cross", value: 5 },
        },
      },
    ],
  };

  it("reads actual margin and negative position sizes without granting authority", () => {
    const result = parseHyperliquidAccount(state);
    expect(result.equity).toBe("350.52");
    expect(result.marginUsed).toBe("48.25");
    const optional = parseHyperliquidAccount({
      ...state,
      assetPositions: [
        {
          position: {
            ...state.assetPositions[0]!.position,
            liquidationPx: "NaN",
          },
        },
      ],
    });
    expect(optional.positions[0]?.liquidationPrice).toBeNull();
    expect(result.positions[0]).toMatchObject({
      coin: "BTC",
      size: "-0.005",
      unrealizedPnl: "-1.2",
      leverage: 5,
      leverageType: "cross",
    });
  });

  it("rejects incomplete, malformed or nonfinite balances and positions", () => {
    expect(() => parseHyperliquidAccount({})).toThrow();
    expect(() =>
      parseHyperliquidAccount({
        ...state,
        marginSummary: { ...state.marginSummary, accountValue: "Infinity" },
      }),
    ).toThrow();
    expect(() =>
      parseHyperliquidAccount({
        ...state,
        assetPositions: [
          {
            position: { ...state.assetPositions[0]!.position, leverage: null },
          },
        ],
      }),
    ).toThrow();
  });

  it("normalises open orders while preserving explicit exchange direction", () => {
    const open = parseHyperliquidOpenOrders([
      { coin: "ETH", side: "B", oid: 15, limitPx: "2100.5", sz: "1.25" },
      { coin: "BTC", side: "A", oid: 16, limitPx: "60000", sz: "0.2" },
    ]);
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({
      direction: "BUY",
      limitPrice: "2100.5",
      size: "1.25",
    });
    expect(open[1]?.direction).toBe("SELL");
    expect(() =>
      parseHyperliquidOpenOrders([
        { coin: "BTC", side: "X", oid: 9, limitPx: "1", sz: "1" },
      ]),
    ).toThrow();
  });
});
