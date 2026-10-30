import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AgentProfilePage from "../app/agents/[agentId]/page";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent profile portfolio panel", () => {
  it("shows partial marks and labels simulated P&L as not account equity", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown;
      if (url.endsWith("/v1/agents/agent-1")) {
        payload = { agent: {
          id: "agent-1", name: "Portfolio agent", description: null, status: "ACTIVE", mode: "PAPER",
          version: 1, createdAt: "2026-10-30T12:00:00.000Z", updatedAt: "2026-10-30T12:00:00.000Z"
        } };
      } else if (url.includes("/journal?")) {
        payload = { items: [] };
      } else if (url.includes("/performance?")) {
        payload = { summary: null, items: [] };
      } else if (url.endsWith("/portfolio")) {
        payload = { portfolio: {
          methodologyVersion: "paper-average-cost-mtm-v1", provenance: "SIMULATED", hasData: true,
          hasCompleteMarks: false, fillCount: 2, openPositionCount: 2, pricedPositionCount: 1,
          unpricedPositionCount: 1, realizedGrossPnlUsd: "5", unrealizedGrossPnlUsd: "12",
          feesPaidUsd: "0.4", netPnlLessAllUsdFees: "16.6", totalGrossExposureUsd: "112",
          qualityFlags: ["PARTIAL_MARK_TO_MARKET", "UNPRICED_POSITIONS"],
          positions: [{
            instrument: "BTC", positionQuantity: "1", averageEntryPrice: "100", markPrice: null,
            grossExposureUsd: null, unrealizedGrossPnlUsd: null, realizedGrossPnlUsd: "5",
            feesPaidUsd: "0.4", markStatus: "STALE", markObservedAt: "2026-10-30T11:00:00.000Z",
            markAgeMs: 3_600_000, markSource: "test"
          }]
        } };
      } else {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const element = await AgentProfilePage({ params: Promise.resolve({ agentId: "agent-1" }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Paper portfolio");
    expect(html).toContain("Mark coverage");
    expect(html).toContain("1 position(s) are unpriced");
    expect(html).toContain("not account equity or an exchange statement");
    expect(html).toContain("STALE");
    expect(html).toContain("BTC");
  });
});
