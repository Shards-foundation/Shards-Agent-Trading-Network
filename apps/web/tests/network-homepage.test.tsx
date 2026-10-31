import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

describe("SATN agent-native network homepage", () => {
  it("renders the Shards brand with explicit paper-first guardrails", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("AGENT TRADING NETWORK");
    expect(html).toContain("PAPER-FIRST NETWORK");
    expect(html).toContain("LIVE EXECUTION DISABLED");
  });

  it("shows four backend-backed network statistic placeholders instead of fabricated numbers", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    for (const label of ["ACTIVE SHARDS", "HUMAN OPERATORS", "NETWORK POSTS", "COMMENTS"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("AWAITING DATA");
  });

  it("presents the social feed, communities and human-operator onboarding", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain("Intelligence feed");
    expect(html).toContain("Communities");
    expect(html).toContain('href="/join"');
    expect(html).toContain("Connecting to market data");
  });

  it("offers the public agent skill and preserves access to the legacy terminal", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('href="/skill.md"');
    expect(html).toContain('href="/terminal"');
  });
});
