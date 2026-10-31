import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const endpoint = "https://api.hyperliquid.xyz/info";
type Obj = Record<string, unknown>;
const obj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const decimal = (x: unknown): number | null => {
  if (typeof x !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x)) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const safePrice = (n: number | null): n is number => n !== null && n > 0;
const fail = () => NextResponse.json(
  { error: { code: "HYPERLIQUID_MARKETS_UNAVAILABLE" }, items: [], executionEnabled: false },
  { status: 503, headers: { "Cache-Control": "no-store" } },
);

/** Market metadata and contexts are aligned by array position in the official Hyperliquid API. */
export function parsePerpetualMarkets(payload: unknown, receivedAt: string) {
  if (!Array.isArray(payload) || payload.length !== 2 || !obj(payload[0]) ||
      !Array.isArray(payload[0].universe) || !Array.isArray(payload[1])) {
    throw new Error("Invalid Hyperliquid market contexts");
  }
  const universe = payload[0].universe;
  const contexts = payload[1];
  if (universe.length !== contexts.length || universe.length === 0) throw new Error("Unaligned Hyperliquid data");
  const items = universe.flatMap((item, i) => {
    const ctx = contexts[i];
    if (!obj(item) || !obj(ctx) || typeof item.name !== "string" ||
        !/^[A-Za-z0-9:_./-]{1,64}$/.test(item.name) || item.isDelisted === true) return [];
    const mark = decimal(ctx.markPx);
    const mid = decimal(ctx.midPx);
    const prev = decimal(ctx.prevDayPx);
    const funding = decimal(ctx.funding);
    const openInterest = decimal(ctx.openInterest);
    const volume24h = decimal(ctx.dayNtlVlm);
    if (!safePrice(mark) && !safePrice(mid)) return [];
    const price = safePrice(mark) ? mark : mid!;
    const change24h = safePrice(prev) ? ((price - prev) / prev) * 100 : null;
    return [{
      symbol: item.name,
      mark: price,
      mid: safePrice(mid) ? mid : null,
      change24h: Number.isFinite(change24h) ? change24h : null,
      funding: funding !== null ? funding * 100 : null,
      volume24h: volume24h !== null && volume24h >= 0 ? volume24h : null,
      openInterest: openInterest !== null && openInterest >= 0 ? openInterest : null,
      maxLeverage: typeof item.maxLeverage === "number" && Number.isInteger(item.maxLeverage) ? item.maxLeverage : null,
      observedAt: receivedAt,
    }];
  });
  if (!items.length) throw new Error("No Hyperliquid quotes");
  return items.sort((x, y) => (y.volume24h ?? 0) - (x.volume24h ?? 0)).slice(0, 40);
}
export async function GET(_request: NextRequest) {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "" }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) throw new Error("Upstream rejected");
    const body = await res.json() as unknown;
    const receivedAt = new Date().toISOString();
    return NextResponse.json({
      venue: "hyperliquid", source: endpoint, receivedAt,
      items: parsePerpetualMarkets(body, receivedAt), executionEnabled: false,
      dataType: "PUBLIC_MARKET_CONTEXT",
    }, { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=10" } });
  } catch { return fail(); }
}
