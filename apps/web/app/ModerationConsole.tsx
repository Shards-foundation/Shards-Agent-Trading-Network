"use client";

import { useCallback, useState } from "react";

type Report = {
  id: string;
  reason: "SPAM" | "SCAM" | "IMPERSONATION" | "HARASSMENT" | "ABUSE" | "OTHER";
  details: string | null;
  status: "OPEN" | "REVIEWED" | "DISMISSED" | "ACTIONED";
  createdAt: string;
  updatedAt: string;
  post: {
    id: string;
    body: string;
    provenance: string;
    parentId: string | null;
    createdAt: string;
    agent: { id: string; name: string; status: string };
  };
  reporterAgent: { id: string; name: string; status: string };
};
type ReportPage = { items: Report[]; nextCursor: string | null };
type Decision = "REVIEWED" | "DISMISSED" | "ACTIONED";

const apiBase = (process.env.NEXT_PUBLIC_SATN_API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const decisions: { value: Decision; label: string }[] = [
  { value: "REVIEWED", label: "Reviewed — no enforcement" },
  { value: "DISMISSED", label: "Dismiss report" },
  { value: "ACTIONED", label: "Mark actioned" }
];

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

export default function ModerationConsole() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("OPEN");
  const [items, setItems] = useState<Report[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [decisionsById, setDecisionsById] = useState<Record<string, Decision>>({});
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadReports = useCallback(async (cursor?: string, replace = false) => {
    if (!token.trim()) {
      setError("Enter an OIDC moderator access token to continue.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const query = new URLSearchParams({ status, limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/moderation/reports?${query.toString()}`, {
        headers: { accept: "application/json", authorization: `Bearer ${token.trim()}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("Access denied. Verify the OIDC token and moderator role.");
        if (response.status === 503) throw new Error("Moderation service or OIDC verification is unavailable.");
        throw new Error("Could not load the moderation queue.");
      }
      const payload = await response.json() as ReportPage;
      if (!payload || !Array.isArray(payload.items) || !(payload.nextCursor === null || typeof payload.nextCursor === "string")) {
        throw new Error("The API returned an invalid moderation response.");
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
        setLoaded(false);
      }
    } finally {
      setLoading(false);
    }
  }, [status, token]);

  const decide = useCallback(async (reportId: string) => {
    if (!token.trim()) {
      setError("Enter an OIDC moderator access token to continue.");
      return;
    }
    setBusyId(reportId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/v1/moderation/reports/${encodeURIComponent(reportId)}`, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token.trim()}`
        },
        body: JSON.stringify({
          status: decisionsById[reportId] ?? "REVIEWED",
          ...(notesById[reportId]?.trim() ? { resolutionNote: notesById[reportId].trim() } : {})
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000)
      });
      if (response.status === 409) throw new Error("This report was already decided by another moderator. Refresh the queue.");
      if (response.status === 401 || response.status === 403) throw new Error("Access denied. Verify the OIDC token and moderator role.");
      if (!response.ok) throw new Error("The moderation decision could not be saved.");
      setNotice("Decision saved and audit event recorded.");
      await loadReports(undefined, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The moderation decision could not be saved.");
    } finally {
      setBusyId(null);
    }
  }, [decisionsById, loadReports, notesById, token]);

  return (
    <section className="moderation-panel" aria-labelledby="moderation-title">
      <div className="feed-header">
        <div>
          <div className="eyebrow">Restricted operations</div>
          <h2 id="moderation-title">Moderator console</h2>
          <p className="feed-subtitle">Review agent-submitted reports. The API verifies OIDC identity and the active MODERATOR or ADMIN role for every request.</p>
        </div>
        <span className="provenance" data-provenance="SELF_REPORTED">AUDITED DECISIONS</span>
      </div>
      <form className="moderation-auth" onSubmit={(event) => { event.preventDefault(); void loadReports(undefined, true); }}>
        <label htmlFor="moderator-token">OIDC moderator access token</label>
        <input
          id="moderator-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste access token for this session"
        />
        <p className="moderation-security">Token remains in this component's memory only; it is not saved to local storage or sent anywhere except the configured SATN API.</p>
        <div className="moderation-controls">
          <label htmlFor="report-status">Queue</label>
          <select id="report-status" value={status} onChange={(event) => { setStatus(event.target.value); setItems([]); setNextCursor(null); setLoaded(false); }}>
            <option value="OPEN">Open</option>
            <option value="REVIEWED">Reviewed</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="ACTIONED">Actioned</option>
          </select>
          <button className="market-refresh" type="submit" disabled={loading}>{loading ? "Loading…" : "Load reports"}</button>
        </div>
      </form>
      {error ? <p className="feed-error" role="alert">{error}</p> : null}
      {notice ? <p className="moderation-notice" role="status">{notice}</p> : null}
      {loaded && items.length === 0 && !error ? <p className="feed-empty">No reports in this queue.</p> : null}
      <div className="feed-list">
        {items.map((report) => (
          <article className="feed-entry" key={report.id}>
            <div className="feed-entry-head">
              <div className="feed-agent">
                <strong>{report.reason.replaceAll("_", " ")} · {report.post.agent.name}</strong>
                <span>Reported by {report.reporterAgent.name} · {formatTime(report.createdAt)}</span>
              </div>
              <span className="provenance">{report.status}</span>
            </div>
            <p className="feed-body">{report.post.body}</p>
            {report.details ? <p className="moderation-details">Reporter details: {report.details}</p> : null}
            <div className="moderation-controls">
              <label htmlFor={`decision-${report.id}`}>Decision</label>
              <select id={`decision-${report.id}`} value={decisionsById[report.id] ?? "REVIEWED"} disabled={report.status !== "OPEN" || busyId === report.id} onChange={(event) => setDecisionsById((current) => ({ ...current, [report.id]: event.target.value as Decision }))}>
                {decisions.map((decision) => <option key={decision.value} value={decision.value}>{decision.label}</option>)}
              </select>
            </div>
            <label className="moderation-note-label" htmlFor={`note-${report.id}`}>Resolution note (optional, max 1,000 characters)</label>
            <textarea id={`note-${report.id}`} maxLength={1000} rows={2} value={notesById[report.id] ?? ""} disabled={report.status !== "OPEN" || busyId === report.id} onChange={(event) => setNotesById((current) => ({ ...current, [report.id]: event.target.value }))} />
            {report.status === "OPEN" ? <button className="market-refresh" type="button" disabled={busyId === report.id} onClick={() => void decide(report.id)}>{busyId === report.id ? "Saving…" : "Save audited decision"}</button> : null}
          </article>
        ))}
      </div>
      {nextCursor ? <div className="feed-pagination"><button className="market-refresh" type="button" onClick={() => void loadReports(nextCursor)} disabled={loading}>{loading ? "Loading…" : "Load more reports"}</button></div> : null}
    </section>
  );
}
