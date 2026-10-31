"use client";
import { useCallback, useEffect, useState } from "react";
type Outcome = { name: string; price: number; tokenId: string };
type Market = {
  id: string;
  question: string;
  slug: string | null;
  outcomes: Outcome[];
  volume24h: number | null;
  liquidity: number | null;
};
type Book = {
  tokenId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  tradingBlocked: true;
};
const compact = (n: number | null) =>
  n === null
    ? "—"
    : Intl.NumberFormat("en-GB", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);
export default function PolymarketLive() {
  const [items, setItems] = useState<Market[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState(""),
    [bookError, setBookError] = useState(""),
    [search, setSearch] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/venues/polymarket?limit=36", {
        cache: "no-store",
        signal: AbortSignal.timeout(8500),
      });
      if (!r.ok) throw Error("fetch");
      const d = await r.json();
      if (
        d.venue !== "polymarket" ||
        d.executionEnabled !== false ||
        d.jurisdiction?.tradingBlocked !== true ||
        !Array.isArray(d.items)
      )
        throw Error("payload");
      setItems(d.items);
      setError("");
    } catch {
      setItems([]);
      setError(
        "Polymarket market feed unavailable. Probabilities are not simulated.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!outcome) {
      setBook(null);
      return;
    }
    let active = true;
    async function update() {
      try {
        const r = await fetch(
          `/api/venues/polymarket/book?tokenId=${encodeURIComponent(outcome!.tokenId)}`,
          { cache: "no-store" },
        );
        if (!r.ok) throw Error("book");
        const d = (await r.json()) as Book;
        if (d.tokenId !== outcome!.tokenId || d.tradingBlocked !== true)
          throw Error("mismatch");
        if (active) {
          setBook(d);
          setBookError("");
        }
      } catch {
        if (active) {
          setBook(null);
          setBookError("CLOB book unavailable.");
        }
      }
    }
    void update();
    const t = setInterval(() => void update(), 10000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [outcome]);
  return (
    <section className="venue-live">
      <header>
        <div>
          <small>POLYMARKET · GAMMA + CLOB APIS</small>
          <h2>Prediction markets</h2>
          <p>
            Real market listings and prices, with selectable CLOB outcome order
            books.
          </p>
        </div>
        <b>UK TRADING BLOCKED</b>
      </header>
      <p className="venue-restriction">
        Polymarket currently restricts trading in the UK. Shards provides market
        research only; order placement and deposits are disabled for humans and
        agents.
      </p>
      <div className="venue-actions">
        <input
          aria-label="Search prediction markets"
          placeholder="Search predictions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {error && (
        <p role="alert" className="venue-error">
          {error}
        </p>
      )}
      <div className="venue-layout">
        <div className="venue-events">
          {items
            .filter((x) =>
              x.question.toLowerCase().includes(search.toLowerCase()),
            )
            .map((m) => (
              <article key={m.id}>
                <small>POLYMARKET · MARKET RESEARCH</small>
                <h3>{m.question}</h3>
                <div className="venue-outcomes">
                  {m.outcomes.map((o) => (
                    <button
                      key={o.tokenId}
                      className={o.tokenId === outcome?.tokenId ? "active" : ""}
                      onClick={() => setOutcome(o)}
                    >
                      {o.name} <strong>{(o.price * 100).toFixed(1)}%</strong>
                    </button>
                  ))}
                </div>
                <footer>
                  <span>24h vol: ${compact(m.volume24h)}</span>
                  <span>Liquidity: ${compact(m.liquidity)}</span>
                  {m.slug && (
                    <a
                      target="_blank"
                      rel="noreferrer"
                      href={`https://polymarket.com/market/${encodeURIComponent(m.slug)}`}
                    >
                      Venue details ↗
                    </a>
                  )}
                </footer>
              </article>
            ))}
        </div>
        <aside className="venue-book">
          <small>POLYMARKET CLOB ORDER BOOK</small>
          <h3>{outcome?.name ?? "Select an outcome"}</h3>
          {bookError && <p className="venue-error">{bookError}</p>}
          {book && (
            <div className="venue-depth">
              {[
                ["Bids", book.bids],
                ["Asks", book.asks],
              ].map(([label, levels]) => (
                <div key={label as string}>
                  <strong>{label as string}</strong>
                  {(levels as Book["bids"]).slice(0, 8).map((x, i) => (
                    <p key={i}>
                      {(x.price * 100).toFixed(1)}¢{" "}
                      <span>{compact(x.size)}</span>
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
          <p>
            Public depth only. Jurisdiction checks fail closed before any future
            signing.
          </p>
        </aside>
      </div>
      <footer>
        Official Gamma and CLOB public feeds · Refresh every 30 s · No trading
        access
      </footer>
    </section>
  );
}
