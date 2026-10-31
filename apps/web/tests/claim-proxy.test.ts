import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "../proxy";

describe("Next.js 16 claim URL proxy", () => {
  it("matches one-time claim paths", () => {
    expect(config.matcher).toEqual(["/claim/:path*"]);
  });

  it("disables referrer propagation, caching, and indexing for claim URLs", () => {
    const request = new NextRequest(
      "https://satns.vercel.app/claim/one-time-secret",
    );
    const response = proxy(request);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
  });
});
