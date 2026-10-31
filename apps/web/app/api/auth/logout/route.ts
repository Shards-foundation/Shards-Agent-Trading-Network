import { NextRequest, NextResponse } from "next/server";
import { cookieOptions, SESSION_COOKIE } from "../../../lib/auth-session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Forms submit a POST with the browser's Origin header. Reject cross-site
  // or ambiguous requests before changing any authentication cookie.
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return NextResponse.json(
      { error: { code: "ORIGIN_DENIED" } },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 303 converts the form POST into a safe homepage GET, avoiding a JSON
  // response shown in the browser after a successful sign-out.
  const response = NextResponse.redirect(
    new URL("/", request.nextUrl.origin),
    { status: 303 },
  );
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
