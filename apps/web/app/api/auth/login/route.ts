import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  authConfig,
  cookieOptions,
  OAUTH_NONCE_COOKIE,
  OAUTH_RETURN_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
} from "../../../lib/auth-session";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const { clientId, authorise, origin } = authConfig();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const redirectUri = new URL("/api/auth/callback", origin).toString();
    const url = new URL(authorise);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    if (process.env.OIDC_API_AUDIENCE)
      url.searchParams.set("audience", process.env.OIDC_API_AUDIENCE);
    if (request.nextUrl.searchParams.get("intent") === "signup")
      url.searchParams.set("screen_hint", "signup");
    const response = NextResponse.redirect(url);
    response.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions(600));
    response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, cookieOptions(600));
    response.cookies.set(OAUTH_NONCE_COOKIE, nonce, cookieOptions(600));
    const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "";
    if (/^\/claim\/[a-zA-Z0-9_-]{40,160}$/.test(returnTo)) {
      response.cookies.set(OAUTH_RETURN_COOKIE, returnTo, cookieOptions(600));
    } else {
      response.cookies.set(OAUTH_RETURN_COOKIE, "", {
        ...cookieOptions(0),
        maxAge: 0,
      });
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return new NextResponse("Human registration is not configured yet.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
