import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  authConfig,
  cookieOptions,
  encryptSession,
  OAUTH_NONCE_COOKIE,
  OAUTH_RETURN_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  SESSION_COOKIE,
} from "../../../lib/auth-session";
export const runtime = "nodejs";
const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const storedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const verifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value ?? "";
  const nonce = request.cookies.get(OAUTH_NONCE_COOKIE)?.value ?? "";
  const finish = (response: NextResponse) => {
    for (const cookie of [
      OAUTH_STATE_COOKIE,
      OAUTH_VERIFIER_COOKIE,
      OAUTH_NONCE_COOKIE,
      OAUTH_RETURN_COOKIE,
    ]) {
      response.cookies.set(cookie, "", { ...cookieOptions(0), maxAge: 0 });
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (
    !state ||
    !storedState ||
    !equal(state, storedState) ||
    code.length < 8 ||
    !verifier ||
    !nonce
  ) {
    return finish(
      new NextResponse("Invalid or expired sign-in attempt.", { status: 400 }),
    );
  }
  try {
    const { clientId, token, origin, sessionKey } = authConfig();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/api/auth/callback", origin).toString(),
      client_id: clientId,
      code_verifier: verifier,
    });
    if (process.env.OIDC_CLIENT_SECRET)
      form.set("client_secret", process.env.OIDC_CLIENT_SECRET);
    const exchange = await fetch(token, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    if (!exchange.ok) throw new Error("Token exchange unsuccessful");
    const result = (await exchange.json()) as Record<string, unknown>;
    if (
      typeof result.access_token !== "string" ||
      result.access_token.length < 10 ||
      typeof result.expires_in !== "number" ||
      result.expires_in <= 0
    )
      throw new Error("Invalid token exchange");
    // Only issue short-lived sessions; the API independently validates the OIDC JWT.
    const lifespan = Math.min(Math.floor(result.expires_in), 3600);
    const expiresAt = Date.now() + lifespan * 1000 - 30000;
    if (expiresAt <= Date.now()) throw new Error("Token expires too soon");
    const returnTo = request.cookies.get(OAUTH_RETURN_COOKIE)?.value ?? "";
    const destination = /^\/claim\/[a-zA-Z0-9_-]{40,160}$/.test(returnTo)
      ? returnTo
      : "/join?connected=1";
    // Register the human in Shards itself and independently validate the OIDC
    // access token with the API before creating a browser session.
    const api =
      process.env.SATN_API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SATN_API_URL;
    if (!api) throw new Error("API origin unavailable");
    const ownerEndpoint = new URL("/v1/owners/me", api);
    if (
      ownerEndpoint.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        ownerEndpoint.hostname === "localhost"
      )
    ) {
      throw new Error("API requires HTTPS");
    }
    const ownerResponse = await fetch(ownerEndpoint, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: { Authorization: `Bearer ${result.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!ownerResponse.ok)
      throw new Error("Owner registration rejected by API");
    const response = NextResponse.redirect(new URL(destination, origin));
    response.cookies.set(
      SESSION_COOKIE,
      encryptSession(result.access_token, expiresAt, sessionKey),
      cookieOptions(lifespan),
    );
    return finish(response);
  } catch {
    return finish(
      new NextResponse(
        "Sign-in failed. Check the identity provider configuration.",
        { status: 502 },
      ),
    );
  }
}
