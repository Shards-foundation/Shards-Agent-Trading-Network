"use client";

import { useCallback, useEffect, useState } from "react";

type PaperTrade = {
  id: string;
  venue: string;
  instrument: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  limitPrice: string | null;
  status: string;
  createdAt: string;
  provenance: "SIMULATED" | "NOT_EXECUTED";
  agent: { id: string; name: string; mode: string };
  riskDecision: { outcome: "APPROVED" | "REJECTED"; reasonCodes: string[]; policyVersion: number; evaluatedAt: string } | null;
  venueOrder: { state: string; fills: { price: string; quantity: string; fee: string; feeAsset: string; filledAt: string }[] } | null;
};

type TradeResponse = { items: PaperTrade[]; nextCursor: string | null };
const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

export default function TradePanel() {
  const [items, setItems] = useState<PaperTrade[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string, replace = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "10" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/trades?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error("Paper-trade activity is currently unavailable.");
      const payload = await response.json() as TradeResponse;
      if (!payload || !Array.isArray(payload.items) || !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
        throw new Error("The API returned an invalid paper-trade response.");
      }
      setItems((current) => {
        const combined = replace ? payload.items : [...current, ...payload.items];
        const seen = new Set<string>();
        return combined.filter((entry) => {
          if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) return false;
          seen.add(entry.id);
          return typeof entry.instrument === "string" && typeof entry.agent?.name === "string";
        });
      });
      setNextCursor(payload.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load paper-trade activity.");
      if (replace) {
        setItems([]);
        setNextCursor(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(undefined, true);
  }, [load]);

  return (
    <section className="trade-panel" aria-labelledby="trade-panel-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Paper environment only</div>
          <h2 id="trade-panel-title">Agent trade activity</h2>
          <p className="feed-subtitle">Public paper intents and simulated fills. This is not live execution, audited profit or investment advice.</p>
        </div>
        <button className="market-refresh" type="button" onClick={() => void load(undefined, true)} disabled={loading}>
          {loading ? "Loading…" : "Refresh trades"}
        </button>
      </div>
      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {!loaded && loading ? <p className="feed-empty" aria-live="polite">Connecting to paper-trade activity…</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No paper-trade activity yet. Orders will appear after an agent submits a valid paper intent.</p> : null}

      <div className="feed-list">
        {items.map((trade) => {
          const fill = trade.venueOrder?.fills[0];
          return (
            <article className="trade-entry" key={trade.id}>
              <div className="feed-entry-head">
                <div className="feed-agent">
                  <strong>{trade.agent.name} <span className="trade-side">{trade.side}</span> {trade.instrument}</strong>
                  <span>{trade.venue.toUpperCase()} · {formatTime(trade.createdAt)}</span>
                </div>
                <span className="provenance" data-provenance={trade.provenance}>{trade.provenance.replace("_", " ")}</span>
              </div>
              <div className="trade-stats">
                <div><span>Quantity</span><strong>{trade.quantity}</strong></div>
                <div><span>Limit</span><strong>{trade.limitPrice ?? "—"}</strong></div>
                <div><span>Status</span><strong>{trade.status.replaceAll("_", " ")}</strong></div>
                <div><span>Fill / fee</span><strong>{fill ? `${fill.price} / ${fill.fee} ${fill.feeAsset}` : "No fill"}</strong></div>
              </div>
              {trade.riskDecision?.outcome === "REJECTED" ? (
                <p className="trade-rejection">Risk gate: {trade.riskDecision.reasonCodes.join(", ") || "Rejected"}</p>
              ) : null}
            </article>
          );
        })}
      </div>
      {nextCursor ? (
        <div className="feed-pagination">
          <button className="market-refresh" type="button" onClick={() => void load(nextCursor)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
