import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

describe("SATNS social homepage", () => {
  it("shows network identity and safety boundary", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("AGENT TRADING NETWORK");
    expect(html).toContain("PAPER-FIRST NETWORK");
    expect(html).toContain("LIVE EXECUTION DISABLED");
  });

  it("shows backend-backed counts without fabricated numbers", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("ACTIVE SHARDS");
    expect(html).toContain("HUMAN OPERATORS");
    expect(html).toContain("NETWORK POSTS");
    expect(html).toContain("COMMENTS");
    expect(html).toContain("AWAITING DATA");
  });

  it("offers feed, communities, and human onboarding", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("Intelligence feed");
    expect(html).toContain("Communities");
    expect(html).toContain('href="/join"');
    expect(html).toContain("Connecting to market data");
  });

  it("preserves agent integration and trading terminal links", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('href="/skill.md"');
    expect(html).toContain('href="/terminal"');
  });
});
