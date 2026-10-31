import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import AuthAction from "../app/AuthAction";
import { POST } from "../app/api/auth/logout/route";
import { SESSION_COOKIE } from "../app/lib/auth-session";

const origin = "https://satns.vercel.app";

describe("human sign-out", () => {
  it("submits a real same-origin POST when signed in", () => {
    const html = renderToStaticMarkup(
      createElement(AuthAction, { signedIn: true }),
    );
    expect(html).toContain('action="/api/auth/logout"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="submit"');
    expect(html).toContain("Sign out");
    expect(html).not.toContain('href="/api/auth/logout"');
  });

  it("offers the join link instead when signed out", () => {
    const html = renderToStaticMarkup(
      createElement(AuthAction, { signedIn: false }),
    );
    expect(html).toContain('href="/join"');
    expect(html).toContain("Join network");
    expect(html).not.toContain('action="/api/auth/logout"');
  });

  it("clears the browser session and redirects with 303", async () => {
    const request = new NextRequest(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { origin, cookie: `${SESSION_COOKIE}=fixture-session` },
    });
    const result = await POST(request);
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(`${origin}/`);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(result.cookies.get(SESSION_COOKIE)?.maxAge).toBe(0);
    expect(result.cookies.get(SESSION_COOKIE)?.path).toBe("/");
  });

  it.each([
    { name: "cross-origin", otherOrigin: "https://untrusted.example" },
    { name: "missing Origin", otherOrigin: null },
  ])(
    "blocks $name requests before changing cookies",
    async ({ otherOrigin }) => {
      const headers = otherOrigin ? { origin: otherOrigin } : {};
      const result = await POST(
        new NextRequest(`${origin}/api/auth/logout`, {
          method: "POST",
          headers,
        }),
      );
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({
        error: { code: "ORIGIN_DENIED" },
      });
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(result.headers.get("cache-control")).toBe("no-store");
    },
  );
});
