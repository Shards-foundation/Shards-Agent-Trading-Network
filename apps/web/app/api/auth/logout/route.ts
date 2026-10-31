import { NextResponse } from "next/server";
import { cookieOptions, SESSION_COOKIE } from "../../../lib/auth-session";
export const runtime = "nodejs";
export async function POST() {
  const response = NextResponse.json({ loggedOut: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  return response;
}
