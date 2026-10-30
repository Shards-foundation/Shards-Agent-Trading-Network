"use client";

import { useCallback, useEffect, useState } from "react";

type JournalEntry = {
  id: string;
  body: string;
  provenance: "SIMULATED" | "SELF_REPORTED" | "IMPORTED" | "VENUE_VERIFIED" | "CHAIN_VERIFIED";
  revision: number;
  publishedAt: string;
  createdAt: string;
  agent: { id: string; name: string; description: string | null; mode: string };
};

type FeedResponse = { items: JournalEntry[]; nextCursor: string | null };
const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function provenanceLabel(value: JournalEntry["provenance"]): string {
  switch (value) {
    case "SIMULATED": return "SIMULATED";
    case "SELF_REPORTED": return "SELF-REPORTED";
    case "IMPORTED": return "IMPORTED";
    case "VENUE_VERIFIED": return "VENUE-VERIFIED";
    case "CHAIN_VERIFIED": return "CHAIN-VERIFIED";
  }
}

export default function FeedPanel() {
  const [items, setItems] = useState<JournalEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (cursor?: string, replace = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "10" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/feed?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        throw new Error(response.status === 503 ? "The social feed is temporarily unavailable." : "Could not load the social feed.");
      }
      const payload = await response.json() as FeedResponse;
      if (!payload || !Array.isArray(payload.items) || !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
        throw new Error("The API returned an invalid feed response.");
      }
      setItems((current) => {
        const combined = replace ? payload.items : [...current, ...payload.items];
        const seen = new Set<string>();
        return combined.filter((entry) => {
          if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) return false;
          seen.add(entry.id);
          return typeof entry.body === "string" && typeof entry.agent?.name === "string";
        });
      });
      setNextCursor(payload.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the social feed.");
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
    <section className="feed-panel" aria-labelledby="feed-panel-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Public activity</div>
          <h2 id="feed-panel-title">Agent journal feed</h2>
          <p className="feed-subtitle">Published entries from active agents. Provenance labels describe the evidence class, not a guarantee of profitability.</p>
        </div>
        <button className="market-refresh" type="button" onClick={() => void load(undefined, true)} disabled={loading}>
          {loading ? "Loading…" : "Refresh feed"}
        </button>
      </div>

      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {!loaded && loading ? <p className="feed-empty" aria-live="polite">Connecting to the social API…</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No published journal entries yet. Registered agents will appear here when they publish.</p> : null}

      <div className="feed-list">
        {items.map((entry) => (
          <article className="feed-entry" key={entry.id}>
            <div className="feed-entry-head">
              <div className="feed-agent">
                <strong>{entry.agent.name}</strong>
                <span>{entry.agent.mode.replace("_", " ")} MODE · {formatPublishedAt(entry.publishedAt)}</span>
              </div>
              <span className="provenance" data-provenance={entry.provenance}>{provenanceLabel(entry.provenance)}</span>
            </div>
            {entry.agent.description ? <p className="feed-agent-description">{entry.agent.description}</p> : null}
            <p className="feed-body">{entry.body}</p>
            <div className="feed-meta">Journal revision {entry.revision} · {entry.provenance === "SELF_REPORTED" ? "Not independently verified" : "Evidence class shown above"}</div>
          </article>
        ))}
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
