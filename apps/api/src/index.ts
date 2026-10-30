import Fastify from "fastify";
import cors from "@fastify/cors";
import { HyperliquidReadOnlyAdapter } from "@satn/venue-adapters/hyperliquid";
import type { MarketSnapshot } from "@satn/venue-adapters";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  EXECUTION_MODE: z.enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED", "HALTED"]).default("PAPER"),
  LIVE_EXECUTION_ENABLED: z.string().default("false")
});
const env = envSchema.parse(process.env);

export interface MarketDataProvider {
  getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot>;
}

export interface DatabaseHealthProbe {
  check(): Promise<void>;
  close(): Promise<void>;
}

export interface BuildServerOptions {
  marketDataProvider?: MarketDataProvider;
  marketCacheTtlMs?: number;
  databaseProbe?: DatabaseHealthProbe | null;
  queueProbe?: DatabaseHealthProbe | null;
  workerProbe?: DatabaseHealthProbe | null;
  now?: () => number;
}

function createDefaultDatabaseProbe(): DatabaseHealthProbe | null {
  if (!process.env.DATABASE_URL) return null;
  const prisma = new PrismaClient();
  return {
    async check() {
      const migrations = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        LIMIT 1
      `;
      if (migrations.length === 0) {
        throw new Error("No successfully applied Prisma migrations were found.");
      }
    },
    async close() {
      await prisma.$disconnect();
    }
  };
}

function createDefaultQueueProbe(): DatabaseHealthProbe | null {
  if (!process.env.REDIS_URL) return null;
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {
    // Connection details are intentionally not surfaced in health responses.
  });
  return {
    async check() {
      if (!client.isOpen) await client.connect();
      await client.ping();
    },
    async close() {
      if (client.isOpen) await client.quit();
    }
  };
}

const instrumentSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9@._/-]+$/);
const DEFAULT_CACHE_TTL_MS = 1_000;
const MAX_CACHE_ENTRIES = 500;

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "*.privateKey", "*.secret"]
    },
    requestIdHeader: "x-correlation-id"
  });
  const marketDataProvider = options.marketDataProvider ?? new HyperliquidReadOnlyAdapter();
  const databaseProbe = options.databaseProbe === undefined
    ? (env.NODE_ENV === "test" ? null : createDefaultDatabaseProbe())
    : options.databaseProbe;
  const queueProbe = options.queueProbe === undefined
    ? (env.NODE_ENV === "test" ? null : createDefaultQueueProbe())
    : options.queueProbe;
  // No worker is registered in this release, so readiness remains closed by default.
  const workerProbe = options.workerProbe ?? null;
  const cacheTtlMs = options.marketCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const marketCache = new Map<string, { snapshot: MarketSnapshot; expiresAt: number }>();
  const inFlight = new Map<string, Promise<MarketSnapshot>>();

  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60_000) {
    throw new Error("marketCacheTtlMs must be an integer between 0 and 60000.");
  }

  app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.addHook("onClose", async () => {
    await Promise.all([databaseProbe?.close(), queueProbe?.close(), workerProbe?.close()]);
  });

  app.get("/health/live", async () => ({
    status: "ok",
    service: "satn-api",
    timestamp: new Date(now()).toISOString()
  }));

  app.get("/health/ready", async (_request, reply) => {
    let databaseState: "connected" | "unavailable" | "not-configured" = "not-configured";
    if (databaseProbe) {
      try {
        await databaseProbe.check();
        databaseState = "connected";
      } catch {
        databaseState = "unavailable";
      }
    }

    let redisState: "connected" | "unavailable" | "not-configured" = "not-configured";
    if (queueProbe) {
      try {
        await queueProbe.check();
        redisState = "connected";
      } catch {
        redisState = "unavailable";
      }
    }

    let workerState: "connected" | "unavailable" | "not-configured" = "not-configured";
    if (workerProbe) {
      try {
        await workerProbe.check();
        workerState = "connected";
      } catch {
        workerState = "unavailable";
      }
    }

    const ready = databaseState === "connected" &&
      redisState === "connected" && workerState === "connected";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "degraded",
      ready,
      dependencies: { database: databaseState, redis: redisState, worker: workerState },
      execution: {
        mode: env.EXECUTION_MODE,
        liveEnabled: false
      }
    });
  });

  app.get("/v1/venues", async () => ({
    venues: [
      { id: "hyperliquid", status: "read-only", capabilities: ["market-data", "paper-trading"] },
      { id: "polymarket", status: "planned", capabilities: ["market-discovery"] },
      { id: "pump-fun", status: "read-only-review", capabilities: ["approved-public-data"] },
      { id: "uniswap", status: "planned", capabilities: ["quote-only"] }
    ],
    liveExecutionEnabled: false
  }));

  app.get<{ Params: { instrumentId: string } }>("/v1/market/:instrumentId", async (request, reply) => {
    const parsed = instrumentSchema.safeParse(request.params.instrumentId);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_INSTRUMENT",
          message: "The instrument identifier is invalid.",
          correlationId: request.id,
          retryable: false
        }
      });
    }

    const instrumentId = parsed.data;
    const cached = marketCache.get(instrumentId);
    if (cached && cached.expiresAt > now()) {
      return reply.header("x-cache", "HIT").send({ snapshot: cached.snapshot });
    }
    marketCache.delete(instrumentId);

    try {
      let pending = inFlight.get(instrumentId);
      if (!pending) {
        pending = marketDataProvider.getMarketSnapshot(instrumentId);
        inFlight.set(instrumentId, pending);
      }
      const snapshot = await pending;
      if (snapshot.instrumentId !== instrumentId || snapshot.venue !== "hyperliquid") {
        throw new Error("Market-data provider returned a mismatched instrument or venue.");
      }

      if (cacheTtlMs > 0) {
        if (marketCache.size >= MAX_CACHE_ENTRIES && !marketCache.has(instrumentId)) {
          const oldestKey = marketCache.keys().next().value;
          if (oldestKey !== undefined) marketCache.delete(oldestKey);
        }
        marketCache.set(instrumentId, { snapshot, expiresAt: now() + cacheTtlMs });
      }
      return reply.header("x-cache", "MISS").send({ snapshot });
    } catch {
      return reply.code(502).send({
        error: {
          code: "MARKET_DATA_UNAVAILABLE",
          message: "Market data is temporarily unavailable.",
          correlationId: request.id,
          retryable: true
        }
      });
    } finally {
      inFlight.delete(instrumentId);
    }
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource does not exist.",
        retryable: false
      }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error, correlationId: request.id }, "request failed");
    const details: Record<string, unknown> =
      error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
    const candidateStatus = details.statusCode;
    const candidateMessage = details.message;
    const status = typeof candidateStatus === "number" &&
      candidateStatus >= 400 && candidateStatus < 600
      ? candidateStatus
      : 500;
    const message = typeof candidateMessage === "string"
      ? candidateMessage
      : "An unexpected error occurred.";
    return reply.code(status).send({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: status === 500 ? "An unexpected error occurred." : message,
        correlationId: request.id,
        retryable: status >= 500
      }
    });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  app.listen({ host: env.API_HOST, port: env.API_PORT }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
