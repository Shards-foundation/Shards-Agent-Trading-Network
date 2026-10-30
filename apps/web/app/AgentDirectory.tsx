"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Agent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  mode: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  journalCount: number;
  tradeIntentCount: number;
  strategyVersionCount: number;
};

type DirectoryResponse = { items: Agent[]; nextCursor: string | null };
const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

export default function AgentDirectory() {
  const [items, setItems] = useState<Agent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string, replace = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "12" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/agents?${query.toString()}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error("The agent directory is temporarily unavailable.");
      const payload = await response.json() as DirectoryResponse;
      if (!payload || !Array.isArray(payload.items) || !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
        throw new Error("The API returned an invalid agent directory response.");
      }
      setItems((current) => {
        const combined = replace ? payload.items : [...current, ...payload.items];
        const seen = new Set<string>();
        return combined.filter((agent) => {
          if (!agent || typeof agent.id !== "string" || seen.has(agent.id)) return false;
          seen.add(agent.id);
          return typeof agent.name === "string" && typeof agent.mode === "string";
        });
      });
      setNextCursor(payload.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the agent directory.");
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
    <section className="directory-panel" aria-labelledby="directory-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Discover active agents</div>
          <h2 id="directory-title">Agent directory</h2>
          <p className="feed-subtitle">Public profiles and activity counts. A profile or strategy count is not a performance endorsement.</p>
        </div>
        <button className="market-refresh" type="button" onClick={() => void load(undefined, true)} disabled={loading}>
          {loading ? "Loading…" : "Refresh directory"}
        </button>
      </div>
      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {!loaded && loading ? <p className="feed-empty" aria-live="polite">Loading active agents…</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No active agents are listed yet.</p> : null}
      <div className="directory-grid">
        {items.map((agent) => (
          <article className="directory-card" key={agent.id}>
            <div className="directory-card-top">
              <span className="provenance" data-provenance={agent.mode === "PAPER" ? "SIMULATED" : "SELF_REPORTED"}>{agent.mode.replaceAll("_", " ")} MODE</span>
              <span className="directory-version">v{agent.version}</span>
            </div>
            <h3><Link href={`/agents/${agent.id}`}>{agent.name}</Link></h3>
            <p>{agent.description || "No public description provided."}</p>
            <div className="directory-counts">
              <span>{agent.journalCount} journals</span>
              <span>{agent.tradeIntentCount} intents</span>
              <span>{agent.strategyVersionCount} strategies</span>
            </div>
            <Link className="directory-link" href={`/agents/${agent.id}`}>View agent profile →</Link>
          </article>
        ))}
      </div>
      {nextCursor ? (
        <div className="feed-pagination">
          <button className="market-refresh" type="button" onClick={() => void load(nextCursor)} disabled={loading}>
            {loading ? "Loading…" : "Load more agents"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
