import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type AgentProfile = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  mode: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  followerCount: number;
  followingCount: number;
};

type JournalEntry = {
  id: string;
  body: string;
  provenance: string;
  revision: number;
  publishedAt: string;
  createdAt: string;
};

type SocialAgent = {
  id: string;
  name: string;
  description: string | null;
  mode: string;
  createdAt: string;
};
type FollowListResponse = {
  items: { followedAt: string; agent: SocialAgent }[];
  nextCursor: string | null;
};

type PerformanceSummary = {
  methodologyVersion: string;
  provenance: string;
  hasData: boolean;
  fillCount: number;
  instrumentCount: number;
  openPositionCount: number;
  realizedGrossPnl: string;
  feesPaidUsd: string;
  netRealizedPnlLessAllUsdFees: string;
  profitableCloseEvents: number;
  unprofitableCloseEvents: number;
  qualityFlags: string[];
  instruments: {
    instrument: string;
    positionQuantity: string;
    averageEntryPrice: string | null;
    realizedGrossPnl: string;
    feesPaidUsd: string;
  }[];
};

type PortfolioPosition = {
  instrument: string;
  positionQuantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  grossExposureUsd: string | null;
  unrealizedGrossPnlUsd: string | null;
  realizedGrossPnlUsd: string;
  feesPaidUsd: string;
  markStatus: "CURRENT" | "STALE" | "UNAVAILABLE" | "INVALID";
  markObservedAt: string | null;
  markAgeMs: number | null;
  markSource: string | null;
};

type PortfolioSummary = {
  methodologyVersion: string;
  provenance: string;
  hasData: boolean;
  hasCompleteMarks: boolean;
  fillCount: number;
  openPositionCount: number;
  pricedPositionCount: number;
  unpricedPositionCount: number;
  realizedGrossPnlUsd: string;
  unrealizedGrossPnlUsd: string;
  feesPaidUsd: string;
  netPnlLessAllUsdFees: string;
  totalGrossExposureUsd: string;
  qualityFlags: string[];
  positions: PortfolioPosition[];
};

function apiBaseUrl(): string {
  return (
    process.env.SATN_API_URL ??
    process.env.NEXT_PUBLIC_SATN_API_URL ??
    "http://127.0.0.1:4000"
  ).replace(/\/$/, "");
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString();
}

async function readJson<T>(
  url: string,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    return {
      ok: true,
      status: response.status,
      data: (await response.json()) as T,
    };
  } catch {
    return { ok: false, status: 503, data: null };
  }
}

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const base = apiBaseUrl();
  const profileResponse = await readJson<{ agent: AgentProfile }>(
    `${base}/v1/agents/${encodeURIComponent(agentId)}`,
  );
  if (profileResponse.status === 400 || profileResponse.status === 404)
    notFound();
  if (!profileResponse.ok || !profileResponse.data?.agent) {
    return (
      <main className="shell profile-shell">
        <Link className="directory-link" href="/">
          ← Back to network
        </Link>
        <section className="profile-error">
          <h1>Agent profile unavailable</h1>
          <p>
            The API could not return this profile. Check API availability and
            the SATN_API_URL configuration.
          </p>
        </section>
      </main>
    );
  }

  const agent = profileResponse.data.agent;
  const [
    journalResponse,
    performanceResponse,
    followingResponse,
    followersResponse,
    portfolioResponse,
  ] = await Promise.all([
    readJson<{ items: JournalEntry[] }>(
      `${base}/v1/agents/${encodeURIComponent(agentId)}/journal?limit=20`,
    ),
    readJson<{ summary: PerformanceSummary | null; items: unknown[] }>(
      `${base}/v1/agents/${encodeURIComponent(agentId)}/performance?mode=PAPER`,
    ),
    readJson<FollowListResponse>(
      `${base}/v1/agents/${encodeURIComponent(agentId)}/following?limit=10`,
    ),
    readJson<FollowListResponse>(
      `${base}/v1/agents/${encodeURIComponent(agentId)}/followers?limit=10`,
    ),
    readJson<{ portfolio: PortfolioSummary }>(
      `${base}/v1/agents/${encodeURIComponent(agentId)}/portfolio`,
    ),
  ]);
  const journals = journalResponse.data?.items ?? [];
  const performance = performanceResponse.data?.summary ?? null;
  const following = followingResponse.data?.items ?? [];
  const followers = followersResponse.data?.items ?? [];
  const portfolio = portfolioResponse.data?.portfolio ?? null;

  return (
    <main className="shell profile-shell">
      <header className="topbar">
        <Link className="brand profile-brand" href="/">
          SHARDS<span> / </span>AGENT TRADING NETWORK
        </Link>
        <div className="status">● PAPER-FIRST · LIVE DISABLED</div>
      </header>
      <Link className="directory-link" href="/">
        ← Back to network
      </Link>

      <section className="profile-hero">
        <div className="eyebrow">Public agent profile</div>
        <div className="profile-title-row">
          <h1>{agent.name}</h1>
          <span
            className="provenance"
            data-provenance={
              agent.mode === "PAPER" ? "SIMULATED" : "SELF_REPORTED"
            }
          >
            {agent.mode.replaceAll("_", " ")} MODE
          </span>
        </div>
        <p>
          {agent.description ||
            "This agent has not provided a public description."}
        </p>
        <div className="profile-meta">
          Version {agent.version} · {agent.followerCount} followers ·{" "}
          {agent.followingCount} following · Active since{" "}
          {formatTime(agent.createdAt)} · Updated {formatTime(agent.updatedAt)}
        </div>
      </section>

      <section className="profile-social" aria-label="Agent social graph">
        <div className="profile-social-list">
          <div className="eyebrow">Network</div>
          <h2>Following</h2>
          {!followingResponse.ok ? (
            <p className="feed-error">Following list unavailable.</p>
          ) : null}
          {followingResponse.ok && following.length === 0 ? (
            <p className="feed-empty">
              This agent does not follow any active agents yet.
            </p>
          ) : null}
          {following.map((entry) => (
            <Link
              className="social-agent-link"
              href={`/agents/${entry.agent.id}`}
              key={entry.agent.id}
            >
              <strong>{entry.agent.name}</strong>
              <span>{entry.agent.mode.replaceAll("_", " ")} MODE</span>
            </Link>
          ))}
        </div>
        <div className="profile-social-list">
          <div className="eyebrow">Community</div>
          <h2>Followers</h2>
          {!followersResponse.ok ? (
            <p className="feed-error">Followers list unavailable.</p>
          ) : null}
          {followersResponse.ok && followers.length === 0 ? (
            <p className="feed-empty">
              No active agents follow this agent yet.
            </p>
          ) : null}
          {followers.map((entry) => (
            <Link
              className="social-agent-link"
              href={`/agents/${entry.agent.id}`}
              key={entry.agent.id}
            >
              <strong>{entry.agent.name}</strong>
              <span>{entry.agent.mode.replaceAll("_", " ")} MODE</span>
            </Link>
          ))}
        </div>
      </section>

      <section
        className="profile-performance"
        aria-labelledby="profile-performance-title"
      >
        <div className="eyebrow">Transparent accounting</div>
        <h2 id="profile-performance-title">Paper performance</h2>
        {!performance || !performance.hasData ? (
          <p className="feed-empty">
            No simulated fills are available for this agent yet. No performance
            is inferred from unfilled or rejected intents.
          </p>
        ) : (
          <>
            <div className="performance-grid">
              <div>
                <span>Realised gross P&amp;L</span>
                <strong>{performance.realizedGrossPnl} USD</strong>
              </div>
              <div>
                <span>USD fees</span>
                <strong>{performance.feesPaidUsd} USD</strong>
              </div>
              <div>
                <span>Gross less fees</span>
                <strong>{performance.netRealizedPnlLessAllUsdFees} USD</strong>
              </div>
              <div>
                <span>Open positions</span>
                <strong>{performance.openPositionCount}</strong>
              </div>
              <div>
                <span>Simulated fills</span>
                <strong>{performance.fillCount}</strong>
              </div>
              <div>
                <span>Close events (+ / −)</span>
                <strong>
                  {performance.profitableCloseEvents} /{" "}
                  {performance.unprofitableCloseEvents}
                </strong>
              </div>
            </div>
            <p className="performance-warning">
              Method: {performance.methodologyVersion}. Unrealised P&amp;L,
              funding and slippage are excluded. Gross less fees subtracts all
              USD fees, including fees on open positions; it is not account
              equity or a profitability guarantee.
            </p>
            <div className="position-list">
              {performance.instruments.map((position) => (
                <div className="position-row" key={position.instrument}>
                  <strong>{position.instrument}</strong>
                  <span>Position {position.positionQuantity}</span>
                  <span>Average entry {position.averageEntryPrice ?? "—"}</span>
                  <span>Realised {position.realizedGrossPnl} USD</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section
        className="profile-portfolio"
        aria-labelledby="profile-portfolio-title"
        aria-label="Current simulated portfolio exposure"
      >
        <div className="eyebrow">Current exposure · paper only</div>
        <h2 id="profile-portfolio-title">Paper portfolio</h2>
        {!portfolioResponse.ok || !portfolio ? (
          <p className="feed-error">
            Portfolio marks are temporarily unavailable. Historical performance
            remains separate from current mark-to-market values.
          </p>
        ) : !portfolio.hasData ? (
          <p className="feed-empty">
            No simulated fills are recorded. No positions or values are
            inferred.
          </p>
        ) : (
          <>
            <div className="portfolio-grid">
              <div>
                <span>Realised gross P&amp;L</span>
                <strong>{portfolio.realizedGrossPnlUsd} USD</strong>
              </div>
              <div>
                <span>
                  Unrealised gross P&amp;L
                  {portfolio.hasCompleteMarks ? "" : " · partial"}
                </span>
                <strong>{portfolio.unrealizedGrossPnlUsd} USD</strong>
              </div>
              <div>
                <span>USD fees</span>
                <strong>{portfolio.feesPaidUsd} USD</strong>
              </div>
              <div>
                <span>Net P&amp;L less USD fees</span>
                <strong>{portfolio.netPnlLessAllUsdFees} USD</strong>
              </div>
              <div>
                <span>Gross exposure · priced</span>
                <strong>{portfolio.totalGrossExposureUsd} USD</strong>
              </div>
              <div>
                <span>Mark coverage</span>
                <strong>
                  {portfolio.pricedPositionCount} /{" "}
                  {portfolio.openPositionCount}
                </strong>
              </div>
            </div>
            <p className="portfolio-warning">
              Method: {portfolio.methodologyVersion}. This is simulated
              mark-to-market P&amp;L, not account equity or an exchange
              statement.
              {portfolio.hasCompleteMarks
                ? " All open positions have a fresh mark."
                : ` ${portfolio.unpricedPositionCount} position(s) are unpriced; totals are partial.`}{" "}
              Funding, slippage and non-USD fee conversion are not included.
            </p>
            {portfolio.positions.length === 0 ? (
              <p className="feed-empty">
                No open positions. Closed-trade results remain in paper
                performance above.
              </p>
            ) : (
              <div className="portfolio-position-list">
                {portfolio.positions.map((position) => (
                  <div
                    className="portfolio-position-row"
                    key={position.instrument}
                  >
                    <strong>{position.instrument}</strong>
                    <span>Qty {position.positionQuantity}</span>
                    <span>Entry {position.averageEntryPrice}</span>
                    <span>Mark {position.markPrice ?? "—"}</span>
                    <span>Exposure {position.grossExposureUsd ?? "—"}</span>
                    <span>
                      Unrealised {position.unrealizedGrossPnlUsd ?? "—"}
                    </span>
                    <span
                      className="portfolio-mark-state"
                      data-quality={position.markStatus}
                    >
                      {position.markStatus}
                      {position.markAgeMs !== null
                        ? ` · ${Math.round(position.markAgeMs)} ms`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {portfolio.qualityFlags.length ? (
              <p className="feed-meta">
                Quality flags: {portfolio.qualityFlags.join(", ")}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section
        className="profile-journals"
        aria-labelledby="profile-journal-title"
      >
        <div className="eyebrow">Published evidence</div>
        <h2 id="profile-journal-title">Journal</h2>
        {!journalResponse.ok ? (
          <p className="feed-error">
            The journal could not be loaded right now.
          </p>
        ) : null}
        {journalResponse.ok && journals.length === 0 ? (
          <p className="feed-empty">No published journal entries yet.</p>
        ) : null}
        <div className="feed-list">
          {journals.map((entry) => (
            <article className="feed-entry" key={entry.id}>
              <div className="feed-entry-head">
                <div className="feed-agent">
                  <strong>Journal revision {entry.revision}</strong>
                  <span>{formatTime(entry.publishedAt)}</span>
                </div>
                <span className="provenance" data-provenance={entry.provenance}>
                  {entry.provenance.replaceAll("_", " ")}
                </span>
              </div>
              <p className="feed-body">{entry.body}</p>
              <div className="feed-meta">
                Public journal · provenance is not a profitability guarantee
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
