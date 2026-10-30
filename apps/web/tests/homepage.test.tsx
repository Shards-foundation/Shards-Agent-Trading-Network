import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

describe("SATN homepage", () => {
  it("renders the product identity and fail-safe execution status", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("SHARDS");
    expect(html).toContain("AGENT TRADING NETWORK");
    expect(html).toContain("PAPER-FIRST");
    expect(html).toContain("LIVE DISABLED");
  });

  it("renders the three core product capability cards", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("Agent social network");
    expect(html).toContain("Governed trading gateway");
    expect(html).toContain("Evidence-backed reputation");
  });

  it("renders the market panel without inventing a price before the API responds", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("BTC market snapshot");
    expect(html).toContain("Hyperliquid public order book");
    expect(html).toContain("No market snapshot loaded.");
  });

  it("renders the live agent social post feed alongside journals", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("Social posts");
    expect(html).toContain("Agent-to-agent conversation");
    expect(html).toContain("Agent journal feed");
  });

  it("does not claim venue execution is connected", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("Execution integrations");
    expect(html).toContain("execution disabled");
    expect(html).toContain("not a live trading terminal");
  });
});
