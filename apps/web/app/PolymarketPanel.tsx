"use client";

import { useCallback, useEffect, useState } from "react";

type PolymarketMarket = {
  id: string;
  question: string | null;
  slug: string | null;
  conditionId: string;
  outcomes: string[];
  outcomePrices: string[];
  active: boolean;
  closed: boolean;
  volume: number | null;
  liquidity: number | null;
  endDate: string | null;
  acceptingOrders: boolean;
  restricted: boolean;
};
type MarketPage = {
  venue: "polymarket";
  retrievedAt: string;
  limit: number;
  offset: number;
  nextOffset: number | null;
  executionEnabled: false;
  items: PolymarketMarket[];
};
const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const PAGE_SIZE = 12;

function money(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function dateLabel(value: string | null): string {
  if (!value) return "End date not supplied";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "End date unavailable" : `Ends ${date.toLocaleDateString("en-GB")}`;
}
function validMarket(value: unknown): value is PolymarketMarket {
  if (!value || typeof value !== "object") return false;
  const market = value as Partial<PolymarketMarket>;
  return typeof market.id === "string" &&
    typeof market.conditionId === "string" &&
    typeof market.question === "string" &&
    Array.isArray(market.outcomes) && market.outcomes.every((x) => typeof x === "string") &&
    Array.isArray(market.outcomePrices) && market.outcomePrices.every((x) => typeof x === "string") &&
    market.outcomes.length > 0 && market.outcomes.length === market.outcomePrices.length &&
    typeof market.active === "boolean" && typeof market.closed === "boolean";
}

export default function PolymarketPanel() {
  const [items, setItems] = useState<PolymarketMarket[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset = 0, replace = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ venue: "polymarket", limit: String(PAGE_SIZE), offset: String(offset) });
      const response = await fetch(`${apiBase}/v1/markets?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error("Polymarket discovery is currently unavailable.");
      const payload = await response.json() as MarketPage;
      if (!payload || payload.venue !== "polymarket" || payload.executionEnabled !== false ||
          !Array.isArray(payload.items) ||
          !(payload.nextOffset === null || (Number.isInteger(payload.nextOffset) && payload.nextOffset >= 0)) ||
          typeof payload.retrievedAt !== "string") {
        throw new Error("The API returned an invalid Polymarket response.");
      }
      const safeItems = payload.items.filter(validMarket);
      setItems((current) => {
        const combined = replace ? safeItems : [...current, ...safeItems];
        const seen = new Set<string>();
        return combined.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      setNextOffset(payload.nextOffset);
      setRetrievedAt(payload.retrievedAt);
      setLoaded(true);
    } catch {
      setError("Unable to load Polymarket market discovery. Check the API connection and retry.");
      if (replace) {
        setItems([]);
        setNextOffset(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(0, true); }, [load]);

  return (
    <section className="poly-market-panel" aria-labelledby="polymarket-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Public metadata · read-only</div>
          <h2 id="polymarket-title">Polymarket discovery</h2>
          <p className="feed-subtitle">Open market metadata from Gamma API. Prices are provider-reported outcome probabilities, not a recommendation or proof of executable liquidity. No orders are placed.</p>
        </div>
        <button className="market-refresh" type="button" onClick={() => void load(0, true)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh markets"}
        </button>
      </div>
      {retrievedAt ? <p className="poly-market-meta">Retrieved {dateLabel(retrievedAt)} · {new Date(retrievedAt).toLocaleTimeString("en-GB")}</p> : null}
      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {!loaded && loading ? <p className="feed-empty" aria-live="polite">Loading public Polymarket metadata…</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No markets returned for this page.</p> : null}
      <div className="poly-market-grid">
        {items.map((market) => (
          <article className="poly-market-card" key={market.id}>
            <div className="poly-market-card-top">
              <span className="provenance" data-provenance="IMPORTED">{market.closed ? "CLOSED" : market.active ? "ACTIVE" : "INACTIVE"}</span>
              {market.restricted ? <span className="poly-restricted">RESTRICTED</span> : null}
            </div>
            <h3>{market.question ?? "Untitled market"}</h3>
            <div className="poly-outcomes">
              {market.outcomes.map((outcome, index) => {
                const probability = Number(market.outcomePrices[index]);
                return (
                  <div className="poly-outcome" key={`${market.id}-${outcome}`}>
                    <span>{outcome}</span>
                    <strong>{Number.isFinite(probability) && probability >= 0 && probability <= 1 ? `${(probability * 100).toFixed(1)}%` : "—"}</strong>
                  </div>
                );
              })}
            </div>
            <div className="poly-market-stats">
              <div><span>Volume</span><strong>{money(market.volume)}</strong></div>
              <div><span>Liquidity</span><strong>{money(market.liquidity)}</strong></div>
            </div>
            <div className="poly-market-footer">
              <span>{dateLabel(market.endDate)}</span>
              {market.slug ? <a href={`https://polymarket.com/market/${encodeURIComponent(market.slug)}`} target="_blank" rel="noreferrer">Open market ↗</a> : null}
            </div>
          </article>
        ))}
      </div>
      {nextOffset !== null ? (
        <div className="feed-pagination">
          <button className="market-refresh" type="button" onClick={() => void load(nextOffset)} disabled={loading}>
            {loading ? "Loading…" : "Load more markets"}
          </button>
        </div>
      ) : null}
      <p className="poly-market-disclaimer">Discovery only. Geographic restrictions and eligibility may apply. This panel does not submit trades or connect a wallet.</p>
    </section>
  );
}
