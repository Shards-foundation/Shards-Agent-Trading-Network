import { NextRequest, NextResponse } from "next/server";
import { readSession } from "../../../lib/auth-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allowGet =
  /^(stats|communities|posts|my-votes|posts\/[a-f0-9-]{36}\/comments)$/;
const allowPost =
  /^(communities|communities\/[a-z][a-z0-9-]{2,39}\/subscribe|posts\/[a-f0-9-]{36}\/(vote|comments))$/;
/**
 * Network BFF upstreams are origins, not arbitrary URLs. A malformed or
 * unexpectedly privileged configuration must fail closed before fetch().
 */
export function resolveNetworkEndpoint(
  api: string | undefined,
  path: string[],
  search: string,
  nodeEnv: string,
): URL | null {
  if (!api) return null;
  try {
    const upstream = new URL(api);
    const localHttp =
      nodeEnv !== "production" &&
      upstream.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(upstream.hostname);
    if (
      (upstream.protocol !== "https:" && !localHttp) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash
    )
      return null;

    const destination = new URL(`/v1/network/${path.join("/")}`, upstream);
    destination.search = search;
    return destination;
  } catch {
    return null;
  }
}
function endpoint(request: NextRequest, path: string[]): URL | null {
  return resolveNetworkEndpoint(
    process.env.SATN_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SATN_API_URL,
    path,
    request.nextUrl.search,
    process.env.NODE_ENV ?? "development",
  );
}
async function dispatch(
  request: NextRequest,
  path: string[],
  method: "GET" | "POST",
) {
  const joined = path.join("/");
  if (!(method === "GET" ? allowGet : allowPost).test(joined))
    return NextResponse.json(
      { error: { code: "INVALID_ROUTE" } },
      { status: 404 },
    );
  const dest = endpoint(request, path);
  if (!dest)
    return NextResponse.json(
      { error: { code: "NETWORK_API_NOT_CONFIGURED" } },
      { status: 503 },
    );
  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "GET" && joined === "my-votes") {
    const session = readSession(request);
    if (!session)
      return NextResponse.json(
        { error: { code: "SIGN_IN_REQUIRED" } },
        { status: 401 },
      );
    headers.authorization = `Bearer ${session.token}`;
  }
  let body: string | undefined;
  if (method === "POST") {
    if (request.headers.get("origin") !== request.nextUrl.origin)
      return NextResponse.json(
        { error: { code: "ORIGIN_DENIED" } },
        { status: 403 },
      );
    const session = readSession(request);
    if (!session)
      return NextResponse.json(
        { error: { code: "SIGN_IN_REQUIRED" } },
        { status: 401 },
      );
    headers.authorization = `Bearer ${session.token}`;
    try {
      body = JSON.stringify(await request.json());
      if (body.length > 7000) throw new Error("BODY_TOO_LARGE");
    } catch {
      return NextResponse.json(
        { error: { code: "INVALID_BODY" } },
        { status: 400 },
      );
    }
    headers["content-type"] = "application/json";
  }
  try {
    const res = await fetch(dest, {
      method,
      headers,
      body: body ?? null,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8500),
    });
    const text = await res.text();
    if (text.length > 300000)
      return NextResponse.json(
        { error: { code: "RESPONSE_TOO_LARGE" } },
        { status: 502 },
      );
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "NETWORK_SERVICE_UNAVAILABLE" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
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
