import { describe, expect, it } from "vitest";
import { parsePerpetualMarkets } from "../app/api/venues/hyperliquid/route";
import { parseHyperliquidBook } from "../app/api/venues/hyperliquid/book/route";
import { parsePredictionMarkets } from "../app/api/venues/polymarket/route";
import { parsePolymarketBook } from "../app/api/venues/polymarket/book/route";

describe("official market-data adapters", () => {
  it("uses Hyperliquid's aligned metaAndAssetCtxs without fabricated prices", () => {
    const markets = parsePerpetualMarkets(
      [
        {
          universe: [
            { name: "BTC", maxLeverage: 40 },
            { name: "DEL", isDelisted: true },
          ],
        },
        [
          {
            markPx: "50000",
            midPx: "49995",
            prevDayPx: "49000",
            funding: "0.0001",
            dayNtlVlm: "100000",
            openInterest: "20",
          },
          { markPx: "12" },
        ],
      ],
      "2026-10-31T10:00:00Z",
    );
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({
      symbol: "BTC",
      mark: 50000,
      maxLeverage: 40,
    });
    expect(markets[0]!.change24h).toBeGreaterThan(0);
    expect(() => parsePerpetualMarkets([{}, []], "now")).toThrow();
    expect(() =>
      parsePerpetualMarkets([{ universe: [{ name: "BTC" }] }, []], "now"),
    ).toThrow();
  });

  it("rejects mismatched or crossed Hyperliquid books", () => {
    const book = {
      coin: "BTC",
      time: 1793470000000,
      levels: [[{ px: "50", sz: "1" }], [{ px: "51", sz: "2" }]],
    };
    expect(parseHyperliquidBook(book, "BTC").bids[0]?.price).toBe(50);
    expect(() => parseHyperliquidBook(book, "ETH")).toThrow();
    expect(() =>
      parseHyperliquidBook(
        { ...book, levels: [[{ px: "52", sz: "1" }], [{ px: "51", sz: "2" }]] },
        "BTC",
      ),
    ).toThrow();
  });

  it("maps actual Gamma outcome tokens, rejecting invalid probabilities", () => {
    const item = {
      id: "12",
      active: true,
      closed: false,
      question: "Example?",
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.6","0.4"]',
      clobTokenIds: '["1234567890123456","9876543210987654"]',
      volume24hr: "900",
      liquidityNum: "1000",
      acceptingOrders: true,
    };
    const parsed = parsePredictionMarkets([item]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.outcomes[0]).toMatchObject({
      name: "Yes",
      price: 0.6,
      tokenId: "1234567890123456",
    });
    expect(
      parsePredictionMarkets([{ ...item, outcomePrices: '["1.3","0.4"]' }]),
    ).toHaveLength(0);
    expect(() => parsePredictionMarkets({ error: "upstream" })).toThrow();
  });

  it("sorts CLOB depth; rejects mismatched token and crossed prices", () => {
    const token = "1234567890123456";
    const data = {
      asset_id: token,
      bids: [
        { price: "0.3", size: "1" },
        { price: "0.6", size: "2" },
      ],
      asks: [{ price: "0.8", size: "3" }],
    };
    expect(parsePolymarketBook(data, token).bids[0]?.price).toBe(0.6);
    expect(() =>
      parsePolymarketBook({ ...data, asset_id: "wrong" }, token),
    ).toThrow();
    expect(() =>
      parsePolymarketBook(
        { ...data, bids: [{ price: "0.9", size: "2" }] },
        token,
      ),
    ).toThrow();
  });
});
