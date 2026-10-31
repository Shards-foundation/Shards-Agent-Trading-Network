import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const decimal = (v: unknown) =>
  typeof v === "string" &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) &&
  Number.isFinite(Number(v));
export function parseHyperliquidBook(payload: unknown, coin: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Error("Invalid book");
  const book = payload as { coin?: unknown; time?: unknown; levels?: unknown };
  if (
    book.coin !== coin ||
    !Number.isSafeInteger(book.time) ||
    typeof book.time !== "number" ||
    !Array.isArray(book.levels) ||
    book.levels.length !== 2
  )
    throw Error("Invalid book metadata");
  const sides = book.levels.map((levels) => {
    if (!Array.isArray(levels)) throw Error("Invalid book side");
    return levels.slice(0, 12).map((level) => {
      if (
        !level ||
        typeof level !== "object" ||
        Array.isArray(level) ||
        !decimal(level.px) ||
        !decimal(level.sz) ||
        Number(level.px) <= 0 ||
        Number(level.sz) <= 0
      )
        throw Error("Invalid book level");
      return { price: Number(level.px), size: Number(level.sz) };
    });
  });
  if (
    !sides[0]?.length ||
    !sides[1]?.length ||
    sides[0][0]!.price > sides[1][0]!.price
  )
    throw Error("Invalid or crossed book");
  return {
    bids: sides[0],
    asks: sides[1],
    exchangeTime: new Date(book.time).toISOString(),
  };
}
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol") ?? "";
  if (!/^[A-Za-z0-9:_./-]{1,64}$/.test(symbol)) {
    return NextResponse.json(
      { error: { code: "INVALID_SYMBOL" } },
      { status: 400 },
    );
  }
  try {
    const upstream = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: symbol }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(6500),
    });
    if (!upstream.ok) throw Error("Upstream failed");
    const parsed = parseHyperliquidBook(await upstream.json(), symbol);
    const stale = Date.now() - Date.parse(parsed.exchangeTime);
    if (stale < 0 || stale > 30000) throw Error("Stale book");
    return NextResponse.json(
      {
        venue: "hyperliquid",
        symbol,
        ...parsed,
        receivedAt: new Date().toISOString(),
        executionEnabled: false,
      },
      { headers: { "Cache-Control": "public, s-maxage=2" } },
    );
  } catch {
    return NextResponse.json(
      {
        error: { code: "HYPERLIQUID_BOOK_UNAVAILABLE" },
        executionEnabled: false,
      },
      { status: 503 },
    );
  }
}
