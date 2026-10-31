import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const origin = "https://gamma-api.polymarket.com/markets";
const arrayField = (v: unknown): string[] | null => {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(x) && x.every((i) => typeof i === "string") ? x : null;
};
const number = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export function parsePredictionMarkets(value: unknown) {
  if (!Array.isArray(value)) throw Error("Invalid market list");
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const m = raw as Record<string, unknown>;
    const outcomes = arrayField(m.outcomes);
    const prices = arrayField(m.outcomePrices);
    const tokens = arrayField(m.clobTokenIds);
    if (
      (typeof m.id !== "string" && typeof m.id !== "number") ||
      typeof m.question !== "string" ||
      !outcomes ||
      !prices ||
      !tokens ||
      !outcomes.length ||
      outcomes.length !== prices.length ||
      prices.length !== tokens.length ||
      !prices.every(
        (p) =>
          /^0?(?:\.\d+)?$|^1(?:\.0+)?$/.test(p) &&
          Number(p) >= 0 &&
          Number(p) <= 1,
      ) ||
      !tokens.every((t) => /^\d{10,100}$/.test(t)) ||
      m.closed === true ||
      m.active !== true
    )
      return [];
    return [
      {
        id: String(m.id),
        question: m.question,
        slug: typeof m.slug === "string" ? m.slug : null,
        outcomes: outcomes.map((name, i) => ({
          name,
          price: Number(prices[i]),
          tokenId: tokens[i],
        })),
        volume24h: number(m.volume24hr ?? m.volume24hrClob),
        liquidity: number(m.liquidityNum ?? m.liquidity),
        endDate:
          typeof m.endDate === "string" &&
          Number.isFinite(Date.parse(m.endDate))
            ? m.endDate
            : null,
        acceptingOrders: m.acceptingOrders === true,
        restrictedMarket: m.restricted === true,
      },
    ];
  });
}
export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "24");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    return NextResponse.json(
      { error: { code: "INVALID_LIMIT" } },
      { status: 400 },
    );
  try {
    const url = new URL(origin);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw Error("Upstream failed");
    const rows = parsePredictionMarkets(await response.json());
    return NextResponse.json(
      {
        venue: "polymarket",
        source: origin,
        receivedAt: new Date().toISOString(),
        dataType: "PUBLIC_GAMMA_MARKETS",
        executionEnabled: false,
        items: rows,
        jurisdiction: { userEligibilityVerified: false, tradingBlocked: true },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=20, stale-while-revalidate=15",
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        error: { code: "POLYMARKET_MARKETS_UNAVAILABLE" },
        items: [],
        executionEnabled: false,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
