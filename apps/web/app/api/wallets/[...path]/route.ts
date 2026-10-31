import { NextRequest, NextResponse } from "next/server";
import { readSession } from "../../../lib/auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = "[a-f0-9-]{36}";
const allowedPost = new RegExp(`^(challenge|verify|${uuid}/(assign|revoke))$`);

function upstream(raw: string | undefined, path: string): URL | null {
  if (!raw) return null;
  try {
    const base = new URL(raw);
    const local =
      process.env.NODE_ENV !== "production" &&
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname);
    if (
      (!local && base.protocol !== "https:") ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      return null;
    return new URL(
      `/v1/owner/wallets${path === "registered" ? "" : "/" + path}`,
      base,
    );
  } catch {
    return null;
  }
}
async function dispatch(
  request: NextRequest,
  path: string[],
  method: "GET" | "POST",
) {
  const route = path.join("/");
  if (method === "GET" ? route !== "registered" : !allowedPost.test(route))
    return NextResponse.json(
      { error: { code: "INVALID_ROUTE" } },
      { status: 404 },
    );
  const session = readSession(request);
  if (!session)
    return NextResponse.json(
      { error: { code: "SIGN_IN_REQUIRED" } },
      { status: 401 },
    );
  if (
    method === "POST" &&
    request.headers.get("origin") !== request.nextUrl.origin
  )
    return NextResponse.json(
      { error: { code: "ORIGIN_DENIED" } },
      { status: 403 },
    );
  const destination = upstream(
    process.env.SATN_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SATN_API_URL,
    route,
  );
  if (!destination)
    return NextResponse.json(
      { error: { code: "API_NOT_CONFIGURED" } },
      { status: 503 },
    );
  let body: string | undefined;
  if (method === "POST") {
    try {
      body = JSON.stringify(await request.json());
      if (body.length > 1024) throw new Error("too long");
    } catch {
      return NextResponse.json(
        { error: { code: "INVALID_BODY" } },
        { status: 400 },
      );
    }
  }
  try {
    const result = await fetch(destination, {
      method,
      body: body ?? null,
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await result.text();
    if (text.length > 100_000)
      return NextResponse.json(
        { error: { code: "UPSTREAM_TOO_LARGE" } },
        { status: 502 },
      );
    return new NextResponse(text, {
      status: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "WALLET_SERVICE_UNAVAILABLE" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return dispatch(request, (await context.params).path, "GET");
}
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return dispatch(request, (await context.params).path, "POST");
}
