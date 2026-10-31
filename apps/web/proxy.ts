import { NextResponse, type NextRequest } from "next/server";

/**
 * One-time agent claim URLs must not be indexed or leaked by a Referer header.
 * This is a response-header boundary; API authorization happens separately.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/claim/")) {
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export const config = { matcher: ["/claim/:path*"] };
