import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

type JsonRecord = Record<string, unknown>;

function record(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid exchange object");
  }
  return input as JsonRecord;
}

function decimal(input: unknown, optional = false): string | null {
  if (optional && input === null) return null;
  if (typeof input !== "string" || !DECIMAL.test(input) || !Number.isFinite(Number(input))) {
    throw new Error("Invalid exchange decimal");
  }
  return input;
}

export function parseHyperliquidAccount(raw: unknown) {
  const state = record(raw);
  const margin = record(state.marginSummary);
  const equity = decimal(margin.accountValue);
  const marginUsed = decimal(margin.totalMarginUsed);
  const positionNotional = decimal(margin.totalNtlPos);
  if (!Array.isArray(state.assetPositions)) throw new Error("Invalid positions");

  const positions = state.assetPositions.map((rawPosition) => {
    const container = record(rawPosition);
    const p = record(container.position);
    if (typeof p.coin !== "string" || !/^[A-Za-z0-9:_./-]{1,64}$/.test(p.coin)) {
      throw new Error("Invalid position instrument");
    }
    const lev = record(p.leverage);
    if (typeof lev.value !== "number" || !Number.isFinite(lev.value) ||
        lev.value < 1 || lev.value > 100) throw new Error("Invalid leverage");
    return {
      coin: p.coin,
      size: decimal(p.szi),
      entryPrice: decimal(p.entryPx, true),
      positionValue: decimal(p.positionValue),
      unrealizedPnl: decimal(p.unrealizedPnl),
      liquidationPrice: decimal(p.liquidationPx, true),
      leverage: lev.value,
      leverageType: lev.type === "isolated" ? "isolated" : "cross",
    };
  });
  return { equity, marginUsed, positionNotional, positions };
}

export function parseHyperliquidOpenOrders(raw: unknown) {
  if (!Array.isArray(raw)) throw new Error("Invalid open orders");
  return raw.slice(0, 200).map((item) => {
    const order = record(item);
    if (typeof order.coin !== "string" || !/^[A-Za-z0-9:_./-]{1,64}$/.test(order.coin) ||
        (order.side !== "B" && order.side !== "A") ||
        typeof order.oid !== "number" || !Number.isSafeInteger(order.oid)) {
      throw new Error("Invalid order details");
    }
    return {
      coin: order.coin,
      direction: order.side === "B" ? "BUY" : "SELL",
      limitPrice: decimal(order.limitPx),
      size: decimal(order.sz),
      orderId: order.oid,
    };
  });
}

async function info(body: unknown): Promise<unknown> {
  const response = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("Hyperliquid account lookup failed");
  return response.json() as Promise<unknown>;
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!ADDRESS.test(address)) {
    return NextResponse.json(
      { error: { code: "INVALID_WALLET_ADDRESS" }, executionEnabled: false },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const [state, orders] = await Promise.all([
      info({ type: "clearinghouseState", user: address, dex: "" }),
      info({ type: "openOrders", user: address, dex: "" }),
    ]);
    const account = parseHyperliquidAccount(state);
    const openOrders = parseHyperliquidOpenOrders(orders);
    return NextResponse.json(
      {
        venue: "hyperliquid",
        walletAddress: address,
        account,
        openOrders,
        retrievedAt: new Date().toISOString(),
        mode: "PUBLIC_READ_ONLY",
        executionEnabled: false,
      },
      { headers: { "Cache-Control": "public, s-maxage=15" } },
    );
  } catch {
    return NextResponse.json(
      { error: { code: "HYPERLIQUID_ACCOUNT_UNAVAILABLE" }, executionEnabled: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
