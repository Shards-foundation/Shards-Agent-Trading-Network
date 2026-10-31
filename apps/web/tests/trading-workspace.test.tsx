import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TerminalPage from "../app/terminal/page";

describe("governed market workspace", () => {
  it("provides distinct market and operator navigation", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("Spot");
    expect(html).toContain("Perpetuals");
    expect(html).toContain("Predictions");
    expect(html).toContain("Shards");
    expect(html).toContain("Wallet control");
    expect(html).toContain('href="/wallets"');
  });
  it("does not present an unimplemented execution form as functional", () => {
    const html = renderToStaticMarkup(createElement(TerminalPage));
    expect(html).toContain("LIVE ORDERS DISABLED");
    expect(html).toContain("No swap is submitted from this screen");
    expect(html).toContain("Fetching verified market prices");
    expect(html).not.toContain("Buy now");
  });
});
