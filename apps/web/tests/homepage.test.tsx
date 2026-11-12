import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TerminalPage from "../app/terminal/page";

describe("SATN trading workspace", () => {
  it("renders Shards product identity with explicit live execution prohibition", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("SHARDS");
    expect(html).toContain("TRADING NETWORK");
    expect(html).toContain("LIVE ORDERS DISABLED");
    expect(html).toContain("PAPER ENVIRONMENT");
  });

  it("organises market discovery, Shards and operator controls into distinct views", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("Spot");
    expect(html).toContain("Perpetuals");
    expect(html).toContain("Predictions");
    expect(html).toContain("Shards");
    expect(html).toContain("Activity");
    expect(html).toContain("Wallet control");
  });

  it("renders the market panel without inventing prices before API response", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("BTC market snapshot");
    expect(html).toContain("Hyperliquid public order book");
    expect(html).toContain("No market snapshot loaded.");
    expect(html).toContain("Fetching verified market prices");
  });

  it("offers accessible owner wallet controls without implying any signer permission", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain('href="/wallets"');
    expect(html).toContain("Connected signer");
    expect(html).toContain("NOT AUTHORISED");
    expect(html).toContain("Withdrawals");
    expect(html).toContain("BLOCKED");
  });

  it("retains truthful data source labels and avoids unsupported trading", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("Market data");
    expect(html).toContain("Market directory");
    expect(html).toContain("No swap is submitted from this screen.");
    expect(html).toContain("ORDERS OFF");
  });
});
