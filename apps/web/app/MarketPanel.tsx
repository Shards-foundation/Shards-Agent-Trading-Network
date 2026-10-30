"use client";

import { useCallback, useEffect, useState } from "react";

type MarketSnapshot = {
  venue: string;
  instrumentId: string;
  observedAt: string;
  receivedAt: string;
  bid?: string;
  ask?: string;
  dataQuality: "LIVE" | "DELAYED" | "STALE" | "UNKNOWN";
};

type MarketResponse = { snapshot: MarketSnapshot };

const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "Unknown" : timestamp.toLocaleTimeString();
}

export default function MarketPanel() {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/v1/market/BTC`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        throw new Error("Market data is currently unavailable.");
      }
      const payload = await response.json() as MarketResponse;
      if (
        !payload.snapshot ||
        payload.snapshot.instrumentId !== "BTC" ||
        payload.snapshot.venue !== "hyperliquid" ||
        !["LIVE", "DELAYED", "STALE", "UNKNOWN"].includes(payload.snapshot.dataQuality)
      ) {
        throw new Error("The API returned an invalid market snapshot.");
      }
      setSnapshot(payload.snapshot);
    } catch {
      setError("Unable to load Hyperliquid market data. Check the API connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="market-panel" aria-labelledby="market-panel-title">
      <div className="market-panel-header">
        <div>
          <h2 id="market-panel-title">BTC market snapshot</h2>
          <p className="market-subtitle">Hyperliquid public order book · read-only · no order execution</p>
        </div>
        <button className="market-refresh" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh data"}
        </button>
      </div>
      {snapshot ? (
        <>
          <div className="market-grid">
            <div className="market-cell">
              <span className="market-label">Best bid</span>
              <strong className="market-value">{snapshot.bid ?? "—"}</strong>
            </div>
            <div className="market-cell">
              <span className="market-label">Best ask</span>
              <strong className="market-value">{snapshot.ask ?? "—"}</strong>
            </div>
            <div className="market-cell">
              <span className="market-label">Observed at</span>
              <strong className="market-value">{formatTimestamp(snapshot.observedAt)}</strong>
            </div>
          </div>
          <div className="market-state" data-quality={snapshot.dataQuality} aria-live="polite">
            <span>{snapshot.dataQuality === "LIVE" ? "●" : "○"}</span>
            <span>{snapshot.dataQuality} data · received {formatTimestamp(snapshot.receivedAt)}</span>
          </div>
        </>
      ) : (
        <p className="market-empty" aria-live="polite">
          {loading ? "Connecting to the read-only market-data API…" : "No market snapshot loaded."}
        </p>
      )}
      {error ? <p className="market-error" role="alert">{error}</p> : null}
    </section>
  );
}
