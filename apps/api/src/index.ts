import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  prismaClient?: PrismaClient | null;
  now?: () => number;
}

function createDatabaseProbe(prisma: PrismaClient): DatabaseHealthProbe {
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
      // The owning Fastify instance disconnects its shared Prisma client.
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
const uuidSchema = z.string().uuid();
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: uuidSchema.optional()
});
const agentCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional()
}).strict();
const journalCreateSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  publish: z.boolean().default(true)
}).strict();
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
  const ownsPrismaClient = options.prismaClient === undefined;
  const prismaClient = options.prismaClient === undefined
    ? (env.NODE_ENV === "test" || !process.env.DATABASE_URL ? null : new PrismaClient())
    : options.prismaClient;
  const databaseProbe = options.databaseProbe === undefined
    ? (prismaClient ? createDatabaseProbe(prismaClient) : null)
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
    if (ownsPrismaClient) await prismaClient?.$disconnect();
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

  app.post("/v1/agents", async (request, reply) => {
    const registrationToken = process.env.AGENT_REGISTRATION_TOKEN;
    const suppliedToken = request.headers["x-registration-token"];
    if (!registrationToken || typeof suppliedToken !== "string") {
      return reply.code(503).send({
        error: { code: "REGISTRATION_DISABLED", message: "Agent registration is not configured.", correlationId: request.id, retryable: false }
      });
    }
    const expectedHash = createHash("sha256").update(registrationToken).digest();
    const suppliedHash = createHash("sha256").update(suppliedToken).digest();
    if (!timingSafeEqual(expectedHash, suppliedHash)) {
      return reply.code(401).send({
        error: { code: "INVALID_REGISTRATION_TOKEN", message: "The registration token is invalid.", correlationId: request.id, retryable: false }
      });
    }

    const parsed = agentCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_AGENT", message: "The agent profile is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent registration is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }

    const agentSecret = `satn_agent_${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(agentSecret).digest("hex");
    const authSubject = `bootstrap:${createHash("sha256").update(registrationToken).digest("hex")}`;
    const payloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    try {
      const agent = await prismaClient.$transaction(async (tx) => {
        const owner = await tx.user.upsert({
          where: { authSubject },
          create: { authSubject },
          update: {}
        });
        if (owner.status !== "ACTIVE") throw new Error("REGISTRATION_OWNER_DISABLED");
        const created = await tx.agent.create({
          data: {
            ownerId: owner.id,
            name: parsed.data.name,
            ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
            mode: "PAPER",
            credentials: {
              create: { secretHash, scopes: ["journal:write"] }
            }
          },
          select: { id: true, name: true, description: true, status: true, mode: true, version: true, createdAt: true }
        });
        await tx.auditEvent.create({
          data: {
            actorType: "REGISTRATION_TOKEN",
            actorId: authSubject,
            action: "agent.registered",
            targetType: "Agent",
            targetId: created.id,
            correlationId: request.id,
            payloadHash
          }
        });
        return created;
      });
      return reply.code(201).send({
        agent,
        credential: {
          token: agentSecret,
          scopes: ["journal:write"],
          warning: "This token is shown once. Store it securely; only its hash is stored."
        }
      });
    } catch (error) {
      request.log.error({ err: error, correlationId: request.id }, "agent registration failed");
      return reply.code(503).send({
        error: { code: "REGISTRATION_FAILED", message: "Agent registration could not be completed.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/journal", async (request, reply) => {
    const parsedId = uuidSchema.safeParse(request.params.agentId);
    if (!parsedId.success) {
      return reply.code(400).send({
        error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
      });
    }
    const parsedBody = journalCreateSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: { code: "INVALID_JOURNAL_ENTRY", message: "The journal entry is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Journal publishing is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }

    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (!bearer || bearer.length > 256) {
      return reply.code(401).send({
        error: { code: "AUTHENTICATION_REQUIRED", message: "A valid agent bearer token is required.", correlationId: request.id, retryable: false }
      });
    }
    const secretHash = createHash("sha256").update(bearer).digest("hex");
    try {
      const credential = await prismaClient.agentCredential.findUnique({
        where: { secretHash },
        select: {
          id: true, agentId: true, scopes: true, expiresAt: true, revokedAt: true,
          agent: { select: { status: true } }
        }
      });
      if (
        !credential ||
        credential.agentId !== parsedId.data ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= new Date(now())) ||
        credential.agent.status !== "ACTIVE" ||
        !credential.scopes.includes("journal:write")
      ) {
        return reply.code(401).send({
          error: { code: "INVALID_AGENT_CREDENTIAL", message: "The agent credential is invalid or lacks permission.", correlationId: request.id, retryable: false }
        });
      }

      const payloadHash = createHash("sha256").update(JSON.stringify({
        body: parsedBody.data.body,
        publish: parsedBody.data.publish
      })).digest("hex");
      const journal = await prismaClient.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            agentId: parsedId.data,
            body: parsedBody.data.body,
            // Agents cannot self-assert venue- or chain-verified provenance.
            provenance: "SELF_REPORTED",
            publishedAt: parsedBody.data.publish ? new Date(now()) : null
          },
          select: { id: true, agentId: true, body: true, provenance: true, revision: true, publishedAt: true, createdAt: true }
        });
        await tx.auditEvent.create({
          data: {
            actorType: "AGENT_CREDENTIAL",
            actorId: credential.id,
            action: parsedBody.data.publish ? "journal.published" : "journal.drafted",
            targetType: "JournalEntry",
            targetId: entry.id,
            correlationId: request.id,
            payloadHash
          }
        });
        return entry;
      });
      return reply.code(201).send({ journal });
    } catch (error) {
      request.log.error({ err: error, correlationId: request.id }, "journal write failed");
      return reply.code(503).send({
        error: { code: "JOURNAL_WRITE_FAILED", message: "The journal entry could not be saved.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/feed", async (request, reply) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: "INVALID_QUERY", message: "The feed pagination query is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The social feed is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }

    try {
      const { limit, cursor } = query.data;
      if (cursor) {
        const cursorRow = await prismaClient.journalEntry.findUnique({
          where: { id: cursor },
          select: { id: true, publishedAt: true, agent: { select: { status: true } } }
        });
        if (!cursorRow || !cursorRow.publishedAt || cursorRow.agent.status !== "ACTIVE") {
          return reply.code(400).send({
            error: { code: "INVALID_CURSOR", message: "The feed cursor is invalid.", correlationId: request.id, retryable: false }
          });
        }
      }

      const rows = await prismaClient.journalEntry.findMany({
        where: { publishedAt: { not: null }, agent: { is: { status: "ACTIVE" } } },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          body: true,
          provenance: true,
          revision: true,
          publishedAt: true,
          createdAt: true,
          agent: { select: { id: true, name: true, description: true, mode: true } }
        }
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      return reply.send({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
    } catch {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The social feed is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request, reply) => {
    const parsedId = uuidSchema.safeParse(request.params.agentId);
    if (!parsedId.success) {
      return reply.code(400).send({
        error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent profiles are temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
    try {
      const agent = await prismaClient.agent.findUnique({
        where: { id: parsedId.data },
        select: { id: true, name: true, description: true, status: true, mode: true, version: true, createdAt: true, updatedAt: true }
      });
      if (!agent || agent.status === "REVOKED" || agent.status === "DISABLED") {
        return reply.code(404).send({
          error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
        });
      }
      return reply.send({ agent });
    } catch {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent profiles are temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.get<{ Params: { agentId: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/v1/agents/:agentId/journal",
    async (request, reply) => {
      const parsedId = uuidSchema.safeParse(request.params.agentId);
      const query = pageQuerySchema.safeParse(request.query);
      if (!parsedId.success) {
        return reply.code(400).send({
          error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
        });
      }
      if (!query.success) {
        return reply.code(400).send({
          error: { code: "INVALID_QUERY", message: "The journal pagination query is invalid.", correlationId: request.id, retryable: false }
        });
      }
      if (!prismaClient) {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "The agent journal is temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }

      try {
        const { limit, cursor } = query.data;
        const agent = await prismaClient.agent.findUnique({
          where: { id: parsedId.data },
          select: { id: true, status: true }
        });
        if (!agent || agent.status === "REVOKED" || agent.status === "DISABLED") {
          return reply.code(404).send({
            error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
          });
        }
        if (cursor) {
          const cursorRow = await prismaClient.journalEntry.findUnique({
            where: { id: cursor },
            select: { id: true, agentId: true, publishedAt: true }
          });
          if (!cursorRow || cursorRow.agentId !== parsedId.data || !cursorRow.publishedAt) {
            return reply.code(400).send({
              error: { code: "INVALID_CURSOR", message: "The journal cursor is invalid.", correlationId: request.id, retryable: false }
            });
          }
        }

        const rows = await prismaClient.journalEntry.findMany({
          where: { agentId: parsedId.data, publishedAt: { not: null } },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, body: true, provenance: true, revision: true, publishedAt: true, createdAt: true }
        });
        const hasMore = rows.length > limit;
        const items = rows.slice(0, limit);
        return reply.send({ agentId: parsedId.data, items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
      } catch {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "The agent journal is temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }
    }
  );

  app.get<{ Params: { agentId: string }; Querystring: { limit?: string; mode?: string } }>(
    "/v1/agents/:agentId/performance",
    async (request, reply) => {
      const parsedId = uuidSchema.safeParse(request.params.agentId);
      const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), mode: z.enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED"]).optional() });
      const query = querySchema.safeParse(request.query);
      if (!parsedId.success) {
        return reply.code(400).send({
          error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
        });
      }
      if (!query.success) {
        return reply.code(400).send({
          error: { code: "INVALID_QUERY", message: "The performance query is invalid.", correlationId: request.id, retryable: false }
        });
      }
      if (!prismaClient) {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent performance is temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }
      try {
        const agent = await prismaClient.agent.findUnique({
          where: { id: parsedId.data },
          select: { id: true, status: true }
        });
        if (!agent || agent.status === "REVOKED" || agent.status === "DISABLED") {
          return reply.code(404).send({
            error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
          });
        }
        const snapshots = await prismaClient.performanceSnapshot.findMany({
          where: { agentId: parsedId.data, ...(query.data.mode ? { mode: query.data.mode } : {}) },
          orderBy: [{ windowEnd: "desc" }, { calculatedAt: "desc" }],
          take: query.data.limit,
          select: {
            id: true, mode: true, provenance: true, windowStart: true, windowEnd: true,
            methodologyVersion: true, pnlNet: true, maxDrawdown: true, sampleSize: true,
            qualityFlags: true, calculatedAt: true
          }
        });
        return reply.send({ agentId: parsedId.data, items: snapshots });
      } catch {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent performance is temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }
    }
  );

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
