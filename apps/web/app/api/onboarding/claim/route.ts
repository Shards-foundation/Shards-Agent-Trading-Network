import { NextRequest, NextResponse } from "next/server";
import { readSession } from "../../../lib/auth-session";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const session = readSession(request);
  if (!session) return NextResponse.json({ error: "SIGN_IN_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: "ORIGIN_DENIED" }, { status: 403 });
  let claimToken: unknown;
  try { claimToken = (await request.json() as Record<string, unknown>).claimToken; }
  catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  if (typeof claimToken !== "string" || claimToken.length < 40 || claimToken.length > 160) {
    return NextResponse.json({ error: "INVALID_CLAIM" }, { status: 400 });
  }
  const api = process.env.SATN_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SATN_API_URL;
  if (!api) return NextResponse.json({ error: "API_NOT_CONFIGURED" }, { status: 503 });
  try {
    const endpoint = new URL("/v1/agent-registrations/claim", api);
    if (endpoint.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && endpoint.hostname === "localhost")) throw new Error("API must use HTTPS");
    const result = await fetch(endpoint, { method: "POST", redirect: "error", cache: "no-store",
      headers: { "Authorization": `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken }), signal: AbortSignal.timeout(10000) });
    const json = await result.json();
    return NextResponse.json(json, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "CLAIM_SERVICE_UNAVAILABLE" }, { status: 503 });
  }
}
