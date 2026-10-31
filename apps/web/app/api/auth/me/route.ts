import { NextRequest, NextResponse } from "next/server";
import { readSession } from "../../../lib/auth-session";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  return NextResponse.json(
    { authenticated: Boolean(readSession(request)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
