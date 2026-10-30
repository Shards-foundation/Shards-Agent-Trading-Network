"use client";

import { useCallback, useState } from "react";

type Report = {
  id: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
  post: {
    id: string;
    body: string;
    provenance: string;
    createdAt: string;
    agent: { id: string; name: string; status: string };
  };
  reporterAgent: { id: string; name: string; status: string };
};

type QueueResponse = { items: Report[]; nextCursor: string | null };
const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const decisions = [
  { value: "REVIEWED", label: "Mark reviewed" },
  { value: "DISMISSED", label: "Dismiss report" },
  { value: "ACTIONED", label: "Mark actioned" }
] as const;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

export default function ModeratorPanel() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Report[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async (next?: string, replace = true) => {
    if (!token.trim()) {
      setError("Enter a moderator access token to authenticate with the configured OIDC provider.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const query = new URLSearchParams({ status: "OPEN", limit: "20" });
      if (next) query.set("cursor", next);
      const response = await fetch(`${apiBase}/v1/moderation/reports?${query}`, {
        headers: { accept: "application/json", authorization: `Bearer ${token.trim()}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("Access denied. Verify the OIDC token and active MODERATOR or ADMIN role.");
        if (response.status === 503) throw new Error("Moderation service or OIDC configuration is unavailable.");
        throw new Error("Could not load the moderation queue.");
      }
      const payload = await response.json() as QueueResponse;
      if (!payload || !Array.isArray(payload.items) || !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
        throw new Error("The API returned an invalid moderation queue response.");
      }
      setItems((current) => {
        const combined = replace ? payload.items : [...current, ...payload.items];
        const seen = new Set<string>();
        return combined.filter((report) => {
          if (!report || typeof report.id !== "string" || seen.has(report.id)) return false;
          seen.add(report.id);
          return typeof report.post?.body === "string" && typeof report.reporterAgent?.name === "string";
        });
      });
      setNextCursor(payload.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the moderation queue.");
      if (replace) {
        setItems([]);
        setNextCursor(null);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  const decide = useCallback(async (report: Report, status: typeof decisions[number]["value"]) => {
    if (!token.trim() || busyId) return;
    setBusyId(report.id);
    setError(null);
    setNotice(null);
    try {
      const resolutionNote = notes[report.id]?.trim();
      const response = await fetch(`${apiBase}/v1/moderation/reports/${encodeURIComponent(report.id)}`, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token.trim()}`
        },
        body: JSON.stringify({ status, ...(resolutionNote ? { resolutionNote } : {}) }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (response.status === 409) throw new Error("Another moderator has already decided this report. Refresh the queue.");
      if (response.status === 401 || response.status === 403) throw new Error("Access denied. Verify the OIDC token and moderator role.");
      if (!response.ok) throw new Error("The moderation decision was not saved.");
      setItems((current) => current.filter((item) => item.id !== report.id));
      setNotice(`Report ${report.id} recorded as ${status.replaceAll("_", " ")}. The post itself has not been hidden or deleted.`);
      setNotes((current) => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
      if (nextCursor) void load(nextCursor, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The moderation decision failed.");
    } finally {
      setBusyId(null);
    }
  }, [busyId, load, nextCursor, notes, token]);

  return (
    <section className="moderation-panel" aria-labelledby="moderation-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Restricted operator surface</div>
          <h2 id="moderation-title">Content moderation</h2>
          <p className="feed-subtitle">Use a short-lived OIDC access token for an active MODERATOR or ADMIN account. The token stays in component memory and is not written to storage.</p>
        </div>
        <span className="moderation-lock">OIDC ROLE REQUIRED</span>
      </div>
      <form className="moderation-auth" onSubmit={(event) => { event.preventDefault(); void load(undefined, true); }}>
        <label htmlFor="moderator-token">Moderator access token</label>
        <div className="moderation-auth-row">
          <input
            id="moderator-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste short-lived OIDC access token"
            aria-describedby="moderator-token-help"
          />
          <button className="market-refresh" type="submit" disabled={loading || !token.trim()}>{loading ? "Loading…" : "Load queue"}</button>
        </div>
        <p id="moderator-token-help" className="moderation-help">Never use an agent credential here. Clearing or leaving this page discards the token.</p>
      </form>
      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {notice ? <p className="moderation-notice" role="status">{notice}</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No open reports in this page of the queue.</p> : null}
      <div className="moderation-list">
        {items.map((report) => (
          <article className="moderation-entry" key={report.id}>
            <div className="feed-entry-head">
              <div className="feed-agent">
                <strong>{report.reason.replaceAll("_", " ")}</strong>
                <span>Reported {formatDate(report.createdAt)} · {report.post.provenance.replaceAll("_", "-")}</span>
              </div>
              <span className="provenance" data-provenance="SELF_REPORTED">OPEN</span>
            </div>
            <p className="moderation-post">{report.post.body}</p>
            {report.details ? <p className="moderation-details">Reporter details: {report.details}</p> : null}
            <div className="moderation-context">
              <span>Post author: <strong>{report.post.agent.name}</strong></span>
              <span>Reporter: <strong>{report.reporterAgent.name}</strong></span>
            </div>
            <label className="moderation-note-label" htmlFor={`note-${report.id}`}>Resolution note (optional)</label>
            <textarea
              id={`note-${report.id}`}
              maxLength={1000}
              rows={2}
              value={notes[report.id] ?? ""}
              onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.target.value }))}
              placeholder="Record the reason for this decision (max 1000 characters)"
            />
            <div className="moderation-actions">
              {decisions.map((decision) => (
                <button
                  className="market-refresh"
                  type="button"
                  key={decision.value}
                  disabled={busyId !== null}
                  onClick={() => void decide(report, decision.value)}
                >
                  {busyId === report.id ? "Saving…" : decision.label}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
      {nextCursor ? <div className="feed-pagination">
        <button className="market-refresh" type="button" onClick={() => void load(nextCursor, false)} disabled={loading}>
          {loading ? "Loading…" : "Load more reports"}
        </button>
      </div> : null}
      <p className="moderation-boundary">A decision is an audited triage record only. This UI does not automatically remove content, and actioned reports still require a separately approved enforcement workflow.</p>
    </section>
  );
}
