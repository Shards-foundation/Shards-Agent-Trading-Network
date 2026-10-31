import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GET,
  resolveNetworkEndpoint,
} from "../app/api/network/[...path]/route";

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (search = "") =>
  ({ nextUrl: { search } }) as unknown as NextRequest;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("network BFF upstream configuration", () => {
  it.each([
    "not-a-url",
    "javascript:alert(1)",
    "http://api.example.test",
    "https://operator:secret@api.example.test",
    "https://api.example.test/v1",
    "https://api.example.test/?debug=1",
    "https://api.example.test/#frag",
  ])("fails closed for untrusted production origin %s", (url) => {
    expect(resolveNetworkEndpoint(url, ["stats"], "", "production")).toBeNull();
  });

  it("allows development HTTP loopback only, never public plaintext", () => {
    expect(
      resolveNetworkEndpoint(
        "http://127.0.0.1:4000",
        ["stats"],
        "",
        "development",
      )?.href,
    ).toBe("http://127.0.0.1:4000/v1/network/stats");
    expect(
      resolveNetworkEndpoint("http://api.example.test", ["stats"], "", "test"),
    ).toBeNull();
    expect(
      resolveNetworkEndpoint(
        "http://localhost:4000",
        ["stats"],
        "",
        "production",
      ),
    ).toBeNull();
  });

  it("preserves only the intended upstream path and browser query", () => {
    expect(
      resolveNetworkEndpoint(
        "https://api.example.test/",
        ["posts"],
        "?limit=15&community=general",
        "production",
      )?.href,
    ).toBe(
      "https://api.example.test/v1/network/posts?limit=15&community=general",
    );
  });

  it("returns a controlled 503 rather than throwing on malformed environment", async () => {
    vi.stubEnv("SATN_API_INTERNAL_URL", "%not-a-valid-url");
    const response = await GET(request(), context(["stats"]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "NETWORK_API_NOT_CONFIGURED" },
    });
  });

  it("denies unknown network routes before reaching the upstream", async () => {
    vi.stubEnv("SATN_API_INTERNAL_URL", "https://api.example.test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request(), context(["admin", "secrets"]));
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards public GETs to the configured HTTPS API without bearer tokens", async () => {
    vi.stubEnv("SATN_API_INTERNAL_URL", "https://api.example.test");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"items":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("?community=general&limit=15"),
      context(["posts"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url.href).toBe(
      "https://api.example.test/v1/network/posts?community=general&limit=15",
    );
    expect(options.headers).toEqual({ accept: "application/json" });
    expect(options.redirect).toBe("error");
    expect(options.cache).toBe("no-store");
  });

  it("returns a controlled 503 if the upstream cannot be reached", async () => {
    vi.stubEnv("SATN_API_INTERNAL_URL", "https://api.example.test");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private")));
    const response = await GET(request(), context(["stats"]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "NETWORK_SERVICE_UNAVAILABLE" },
    });
  });
});
