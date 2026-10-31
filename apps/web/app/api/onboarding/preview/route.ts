import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin)
    return NextResponse.json({ error: "ORIGIN_DENIED" }, { status: 403 });
  let claimToken: unknown;
  try {
    claimToken = ((await request.json()) as Record<string, unknown>).claimToken;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof claimToken !== "string" ||
    claimToken.length < 40 ||
    claimToken.length > 160
  ) {
    return NextResponse.json({ error: "INVALID_CLAIM" }, { status: 400 });
  }
  const api =
    process.env.SATN_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SATN_API_URL;
  if (!api)
    return NextResponse.json({ error: "API_NOT_CONFIGURED" }, { status: 503 });
  try {
    const endpoint = new URL("/v1/agent-registrations/preview", api);
    if (
      endpoint.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        endpoint.hostname === "localhost"
      )
    )
      throw new Error("API requires HTTPS");
    const result = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken }),
      signal: AbortSignal.timeout(10000),
    });
    return NextResponse.json(await result.json(), {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "REGISTRATION_SERVICE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
