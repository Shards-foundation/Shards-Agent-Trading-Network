import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const toLevel = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid level");
  const v = value as Record<string, unknown>;
  if (
    typeof v.price !== "string" ||
    typeof v.size !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v.price) ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v.size)
  )
    throw Error("Invalid level");
  const price = Number(v.price),
    size = Number(v.size);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    price < 0 ||
    price > 1 ||
    size <= 0
  )
    throw Error("Invalid level");
  return { price, size };
};
export function parsePolymarketBook(value: unknown, tokenId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid orderbook");
  const b = value as Record<string, unknown>;
  if (
    b.asset_id !== tokenId ||
    !Array.isArray(b.bids) ||
    !Array.isArray(b.asks)
  )
    throw Error("Mismatched orderbook");
  const bids = b.bids
    .map(toLevel)
    .sort((a, z) => z.price - a.price)
    .slice(0, 12);
  const asks = b.asks
    .map(toLevel)
    .sort((a, z) => a.price - z.price)
    .slice(0, 12);
  if (bids.length && asks.length && bids[0]!.price > asks[0]!.price)
    throw Error("Crossed book");
  return {
    bids,
    asks,
    exchangeTime: typeof b.timestamp === "string" ? b.timestamp : null,
  };
}
export async function GET(request: NextRequest) {
  const tokenId = request.nextUrl.searchParams.get("tokenId") ?? "";
  if (!/^\d{10,100}$/.test(tokenId))
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN_ID" } },
      { status: 400 },
    );
  try {
    const url = new URL("https://clob.polymarket.com/book");
    url.searchParams.set("token_id", tokenId);
    const res = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6500),
    });
    if (!res.ok) throw Error("Upstream failed");
    return NextResponse.json(
      {
        venue: "polymarket",
        tokenId,
        ...parsePolymarketBook(await res.json(), tokenId),
        receivedAt: new Date().toISOString(),
        executionEnabled: false,
        tradingBlocked: true,
      },
      { headers: { "Cache-Control": "public, s-maxage=3" } },
    );
  } catch {
    return NextResponse.json(
      {
        error: { code: "POLYMARKET_BOOK_UNAVAILABLE" },
        executionEnabled: false,
      },
      { status: 503 },
    );
  }
}
