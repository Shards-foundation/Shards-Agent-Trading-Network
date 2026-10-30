import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@satn/venue-adapters";
import { buildServer, type DatabaseHealthProbe, type MarketDataProvider } from "./index.js";

const snapshot: MarketSnapshot = {
  venue: "hyperliquid",
  instrumentId: "BTC",
  observedAt: "2026-10-30T12:00:00.000Z",
  receivedAt: "2026-10-30T12:00:00.100Z",
  source: "https://api.hyperliquid.xyz/info",
  sequence: "1793361600000",
  bid: "99.5",
  ask: "100",
  dataQuality: "LIVE"
};

describe("SATN API", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer({ databaseProbe: null, queueProbe: null });
  });

  afterEach(async () => {
    await app.close();
  });

  it("exposes liveness without requiring external services", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "satn-api" });
  });

  it("does not claim readiness before database and queue adapters exist", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      ready: false,
      dependencies: { database: "not-configured", redis: "not-configured" }
    });
    expect(response.json().execution.liveEnabled).toBe(false);
  });


  it("reports the database as connected but keeps readiness closed without Redis", async () => {
    const probe: DatabaseHealthProbe = { check: async () => undefined, close: async () => undefined };
    const testApp = buildServer({ databaseProbe: probe });
    try {
      const response = await testApp.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "degraded",
        ready: false,
        dependencies: { database: "connected", redis: "not-configured" }
      });
    } finally {
      await testApp.close();
    }
  });

  it("reports ready only when database, Redis and worker probes pass", async () => {
    const probe: DatabaseHealthProbe = { check: async () => undefined, close: async () => undefined };
    const testApp = buildServer({ databaseProbe: probe, queueProbe: probe, workerProbe: probe });
    try {
      const response = await testApp.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ok",
        ready: true,
        dependencies: { database: "connected", redis: "connected", worker: "connected" }
      });
    } finally {
      await testApp.close();
    }
  });

  it("reports an unavailable Redis dependency without leaking connection details", async () => {
    const databaseProbe: DatabaseHealthProbe = { check: async () => undefined, close: async () => undefined };
    const queueProbe: DatabaseHealthProbe = {
      check: async () => { throw new Error("private Redis connection details"); },
      close: async () => undefined
    };
    const testApp = buildServer({ databaseProbe, queueProbe });
    try {
      const response = await testApp.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().dependencies.redis).toBe("unavailable");
      expect(response.body).not.toContain("private Redis connection details");
    } finally {
      await testApp.close();
    }
  });

  it("reports a database probe failure without leaking connection details", async () => {
    const probe: DatabaseHealthProbe = {
      check: async () => { throw new Error("private database connection string"); },
      close: async () => undefined
    };
    const testApp = buildServer({ databaseProbe: probe });
    try {
      const response = await testApp.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().dependencies.database).toBe("unavailable");
      expect(response.body).not.toContain("private database connection string");
    } finally {
      await testApp.close();
    }
  });

  it("declares actual adapter capability without implying live execution", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/venues" });
    expect(response.statusCode).toBe(200);
    expect(response.json().liveExecutionEnabled).toBe(false);
    expect(response.json().venues.find((venue: { id: string }) => venue.id === "hyperliquid").status)
      .toBe("read-only");
    expect(response.json().venues.find((venue: { id: string }) => venue.id === "pump-fun").status)
      .toBe("read-only-review");
  });

  it("returns read-only market data and identifies cache misses", async () => {
    const provider: MarketDataProvider = { getMarketSnapshot: vi.fn().mockResolvedValue(snapshot) };
    const testApp = buildServer({ marketDataProvider: provider });
    try {
      const response = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-cache"]).toBe("MISS");
      expect(response.json().snapshot).toEqual(snapshot);
      expect(provider.getMarketSnapshot).toHaveBeenCalledOnce();
      expect(provider.getMarketSnapshot).toHaveBeenCalledWith("BTC");
    } finally {
      await testApp.close();
    }
  });

  it("caches snapshots within the configured TTL", async () => {
    let nowMs = 1_000;
    const provider: MarketDataProvider = { getMarketSnapshot: vi.fn().mockResolvedValue(snapshot) };
    const testApp = buildServer({ marketDataProvider: provider, marketCacheTtlMs: 500, now: () => nowMs });
    try {
      const first = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      const second = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(first.headers["x-cache"]).toBe("MISS");
      expect(second.headers["x-cache"]).toBe("HIT");
      expect(provider.getMarketSnapshot).toHaveBeenCalledOnce();

      nowMs += 501;
      const third = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(third.headers["x-cache"]).toBe("MISS");
      expect(provider.getMarketSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await testApp.close();
    }
  });

  it("coalesces concurrent requests for the same instrument", async () => {
    let resolveSnapshot: ((value: MarketSnapshot) => void) | undefined;
    const provider: MarketDataProvider = {
      getMarketSnapshot: vi.fn(() => new Promise<MarketSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }))
    };
    const testApp = buildServer({ marketDataProvider: provider, marketCacheTtlMs: 0 });
    try {
      const first = testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      const second = testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      await vi.waitFor(() => expect(provider.getMarketSnapshot).toHaveBeenCalledOnce());
      resolveSnapshot?.(snapshot);
      const [one, two] = await Promise.all([first, second]);
      expect(one.statusCode).toBe(200);
      expect(two.statusCode).toBe(200);
      expect(provider.getMarketSnapshot).toHaveBeenCalledOnce();
    } finally {
      await testApp.close();
    }
  });

  it("marks stale snapshots transparently instead of labelling them live", async () => {
    const stale = { ...snapshot, dataQuality: "STALE" as const };
    const testApp = buildServer({ marketDataProvider: { getMarketSnapshot: async () => stale } });
    try {
      const response = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(response.statusCode).toBe(200);
      expect(response.json().snapshot.dataQuality).toBe("STALE");
    } finally {
      await testApp.close();
    }
  });

  it("rejects invalid instrument identifiers before calling the provider", async () => {
    const provider: MarketDataProvider = { getMarketSnapshot: vi.fn().mockResolvedValue(snapshot) };
    const testApp = buildServer({ marketDataProvider: provider });
    try {
      const response = await testApp.inject({ method: "GET", url: "/v1/market/BTC%0AORDER" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_INSTRUMENT");
      expect(provider.getMarketSnapshot).not.toHaveBeenCalled();
    } finally {
      await testApp.close();
    }
  });

  it("sanitises provider failures and returns a retryable 502", async () => {
    const provider: MarketDataProvider = {
      getMarketSnapshot: vi.fn().mockRejectedValue(new Error("secret upstream internals"))
    };
    const testApp = buildServer({ marketDataProvider: provider });
    try {
      const response = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatchObject({
        code: "MARKET_DATA_UNAVAILABLE",
        message: "Market data is temporarily unavailable.",
        retryable: true
      });
      expect(response.body).not.toContain("secret upstream internals");
    } finally {
      await testApp.close();
    }
  });

  it("rejects mismatched provider responses", async () => {
    const provider: MarketDataProvider = {
      getMarketSnapshot: vi.fn().mockResolvedValue({ ...snapshot, instrumentId: "ETH" })
    };
    const testApp = buildServer({ marketDataProvider: provider });
    try {
      const response = await testApp.inject({ method: "GET", url: "/v1/market/BTC" });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("MARKET_DATA_UNAVAILABLE");
    } finally {
      await testApp.close();
    }
  });

  it("rejects credential lifecycle operations without valid bootstrap authentication", async () => {
    const previous = process.env.AGENT_REGISTRATION_TOKEN;
    process.env.AGENT_REGISTRATION_TOKEN = "test-bootstrap-secret";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/agents/00000000-0000-4000-8000-000000000000/credentials/rotate",
        headers: { "x-registration-token": "wrong-token" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("INVALID_REGISTRATION_TOKEN");

      const invalidId = await app.inject({
        method: "POST",
        url: "/v1/agents/not-a-uuid/pause",
        headers: { "x-registration-token": "test-bootstrap-secret" }
      });
      expect(invalidId.statusCode).toBe(400);
      expect(invalidId.json().error.code).toBe("INVALID_AGENT_ID");
    } finally {
      if (previous === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previous;
    }
  });

  it("fails closed when OIDC configuration is partial or OIDC is enabled without a bearer token", async () => {
    const previous = {
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
      jwksUrl: process.env.OIDC_JWKS_URL,
      registrationToken: process.env.AGENT_REGISTRATION_TOKEN
    };
    process.env.AGENT_REGISTRATION_TOKEN = "bootstrap-must-not-bypass-oidc";
    try {
      process.env.OIDC_ISSUER = "https://issuer.example.test/";
      delete process.env.OIDC_AUDIENCE;
      delete process.env.OIDC_JWKS_URL;
      const misconfigured = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { "x-registration-token": "bootstrap-must-not-bypass-oidc" },
        payload: { name: "OIDC test agent" }
      });
      expect(misconfigured.statusCode).toBe(503);
      expect(misconfigured.json().error.code).toBe("OWNER_AUTH_MISCONFIGURED");

      process.env.OIDC_AUDIENCE = "satn-api";
      process.env.OIDC_JWKS_URL = "https://issuer.example.test/jwks";
      const missingBearer = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { "x-registration-token": "bootstrap-must-not-bypass-oidc" },
        payload: { name: "OIDC test agent" }
      });
      expect(missingBearer.statusCode).toBe(401);
      expect(missingBearer.json().error.code).toBe("INVALID_OWNER_CREDENTIAL");
    } finally {
      if (previous.issuer === undefined) delete process.env.OIDC_ISSUER;
      else process.env.OIDC_ISSUER = previous.issuer;
      if (previous.audience === undefined) delete process.env.OIDC_AUDIENCE;
      else process.env.OIDC_AUDIENCE = previous.audience;
      if (previous.jwksUrl === undefined) delete process.env.OIDC_JWKS_URL;
      else process.env.OIDC_JWKS_URL = previous.jwksUrl;
      if (previous.registrationToken === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previous.registrationToken;
    }
  });

  it("does not allow agent registration when no bootstrap token is configured", async () => {
    const previous = process.env.AGENT_REGISTRATION_TOKEN;
    delete process.env.AGENT_REGISTRATION_TOKEN;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { "x-registration-token": "anything" },
        payload: { name: "Example agent" }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("REGISTRATION_DISABLED");
    } finally {
      if (previous === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previous;
    }
  });

  it("rejects malformed agent registration without requiring a database", async () => {
    const previous = process.env.AGENT_REGISTRATION_TOKEN;
    process.env.AGENT_REGISTRATION_TOKEN = "ci-bootstrap-secret";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { "x-registration-token": "ci-bootstrap-secret" },
        payload: { name: "x", unexpected: "field" }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_AGENT");
    } finally {
      if (previous === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previous;
    }
  });

  it("requires a valid UUID and body before journal writes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agents/not-a-uuid/journal",
      payload: { body: "hello" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_AGENT_ID");
  });

  it("requires an idempotency key for trade intents", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/trade-intents",
      payload: {
        venue: "hyperliquid",
        instrument: "BTC",
        side: "BUY",
        quantity: "1",
        orderType: "LIMIT",
        limitPrice: "100",
        mode: "PAPER"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects live or market-order trade intents before any database access", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/trade-intents",
      headers: { "idempotency-key": "test-live-disabled" },
      payload: {
        venue: "hyperliquid",
        instrument: "BTC",
        side: "BUY",
        quantity: "1",
        orderType: "MARKET",
        mode: "LIVE_RESTRICTED"
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("PAPER_LIMIT_ORDERS_ONLY");
  });

  it("validates agent-directory pagination before querying storage", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/agents?limit=0" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_QUERY");
  });

  it("returns a retryable 503 when the agent directory store is not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/agents" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DATA_STORE_UNAVAILABLE");
  });

  it("validates public trade-feed pagination before querying storage", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/trades?limit=0" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_QUERY");
  });

  it("returns a retryable 503 when the public trade-feed store is not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/trades" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: "DATA_STORE_UNAVAILABLE",
      retryable: true
    });
  });

  it("returns a retryable 503 when the persistent social store is not configured", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/feed" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: "DATA_STORE_UNAVAILABLE",
      retryable: true
    });
  });

  it("validates feed pagination before querying storage", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/feed?limit=51" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_QUERY");
  });

  it("rejects malformed public agent identifiers", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/agents/not-a-uuid" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_AGENT_ID");
  });

  it("rejects unsupported performance modes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/agents/00000000-0000-4000-8000-000000000000/performance?mode=LIVE"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_QUERY");
  });

  it("returns a stable 404 error envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});
