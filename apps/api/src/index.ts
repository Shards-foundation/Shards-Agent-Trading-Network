import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { calculatePaperDailyLoss, calculatePaperPerformance } from "@satn/accounting";
import { verifyOidcAccessToken } from "@satn/auth";
import { evaluateTradeIntent, TradeIntentSchema } from "@satn/risk";
import { simulateLimitOrder } from "@satn/paper-engine";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { HyperliquidReadOnlyAdapter } from "@satn/venue-adapters/hyperliquid";
import { PolymarketReadOnlyDiscoveryAdapter, type PolymarketMarketDiscoveryProvider } from "@satn/venue-adapters/polymarket";
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
  LIVE_EXECUTION_ENABLED: z.literal("false").default("false"),
  PAPER_MAX_ORDER_NOTIONAL: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/).default("1000"),
  PAPER_MAX_DAILY_LOSS: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/).default("100")
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
  polymarketMarketProvider?: PolymarketMarketDiscoveryProvider;
  marketCacheTtlMs?: number;
  databaseProbe?: DatabaseHealthProbe | null;
  queueProbe?: DatabaseHealthProbe | null;
  workerProbe?: DatabaseHealthProbe | null;
  rateLimitStore?: RateLimitStore | null;
  rateLimitReadLimit?: number;
  rateLimitWriteLimit?: number;
  rateLimitWindowSeconds?: number;
  prismaClient?: PrismaClient | null;
  now?: () => number;
}

type OwnerAuthError = "DISABLED" | "MISCONFIGURED" | "INVALID";
type OwnerIdentity = { subject: string; actorType: "OIDC_USER" | "REGISTRATION_TOKEN" };
type OwnerAuthResult = OwnerIdentity | { error: OwnerAuthError };

async function resolveOwnerIdentity(authorization: unknown, suppliedRegistrationToken: unknown): Promise<OwnerAuthResult> {
  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  const oidcConfigured = Boolean(issuer || audience || jwksUrl);

  if (oidcConfigured) {
    if (!issuer || !audience || !jwksUrl) return { error: "MISCONFIGURED" };
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return { error: "INVALID" };
    const token = authorization.slice(7).trim();
    if (!token) return { error: "INVALID" };
    try {
      const identity = await verifyOidcAccessToken(token, { issuer, audience, jwksUrl });
      return { subject: `${identity.issuer}:${identity.subject}`, actorType: "OIDC_USER" };
    } catch {
      return { error: "INVALID" };
    }
  }

  const registrationToken = process.env.AGENT_REGISTRATION_TOKEN;
  if (!registrationToken) return { error: "DISABLED" };
  if (!hasValidRegistrationToken(suppliedRegistrationToken, registrationToken)) return { error: "INVALID" };
  return { subject: registrationAuthSubject(registrationToken), actorType: "REGISTRATION_TOKEN" };
}

function ownerAuthFailure(error: OwnerAuthError, correlationId: string) {
  const unavailable = error === "DISABLED" || error === "MISCONFIGURED";
  const code = error === "DISABLED" ? "OWNER_AUTH_DISABLED" : error === "MISCONFIGURED" ? "OWNER_AUTH_MISCONFIGURED" : "INVALID_OWNER_CREDENTIAL";
  return {
    statusCode: unavailable ? 503 : 401,
    body: {
      error: {
        code,
        message: unavailable ? "Owner authentication is not configured correctly." : "The owner credential is invalid.",
        correlationId,
        retryable: false
      }
    }
  };
}

function hasValidRegistrationToken(suppliedToken: unknown, expectedToken: string | undefined): expectedToken is string {
  if (!expectedToken || typeof suppliedToken !== "string") return false;
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function registrationAuthSubject(token: string): string {
  return `bootstrap:${createHash("sha256").update(token).digest("hex")}`;
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

function createDefaultWorkerProbe(prisma: PrismaClient): DatabaseHealthProbe {
  const maxAgeRaw = process.env.WORKER_STALE_AFTER_MS ?? "30000";
  const maxAgeMs = Number(maxAgeRaw);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("WORKER_STALE_AFTER_MS must be a positive integer.");
  }
  return {
    async check() {
      const rows = await prisma.$queryRaw<Array<{ workerId: string }>>`
        SELECT "workerId"
        FROM "WorkerHeartbeat"
        WHERE "status" = 'RUNNING'
          AND "lastSeenAt" >= CURRENT_TIMESTAMP - (${maxAgeMs} * INTERVAL '1 millisecond')
        LIMIT 1
      `;
      if (rows.length === 0) throw new Error("No healthy worker heartbeat is present.");
    },
    async close() {
      // The API owns and disconnects the shared Prisma client.
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


export interface RateLimitStore {
  consume(key: string, windowSeconds: number): Promise<number>;
  close(): Promise<void>;
}

class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: () => number) {}
  async consume(key: string, windowSeconds: number): Promise<number> {
    const currentTime = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowSeconds * 1000 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [storedKey, stored] of this.buckets) {
        if (stored.resetAt <= currentTime) this.buckets.delete(storedKey);
      }
      while (this.buckets.size > 10_000) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    return bucket.count;
  }
  async close(): Promise<void> { this.buckets.clear(); }
}

const REDIS_RATE_LIMIT_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
  "return count"
].join("\n");

function createDefaultRateLimitStore(now: () => number): RateLimitStore | null {
  if (env.NODE_ENV === "test") return new MemoryRateLimitStore(now);
  if (!process.env.REDIS_URL) return env.NODE_ENV === "production" ? null : new MemoryRateLimitStore(now);
  const client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {
    // Rate-limit backend failures are returned as a generic 503; do not log credentials.
  });
  return {
    async consume(key, windowSeconds) {
      if (!client.isOpen) await client.connect();
      const result = await client.eval(REDIS_RATE_LIMIT_SCRIPT, { keys: [key], arguments: [String(windowSeconds)] });
      const count = Number(result);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid rate-limit counter.");
      return count;
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
const idempotencyKeySchema = z.string().min(1).max(200).regex(/^[\x21-\x7E]+$/);
export function resolvePaperTradePolicy(
  executionMode: "PAPER" | "READ_ONLY" | "LIVE_RESTRICTED" | "HALTED",
  maxOrderNotional: string,
  maxDailyLoss: string
) {
  return {
    allowedVenues: ["hyperliquid"],
    maxOrderNotional,
    liveExecutionEnabled: false,
    // This API endpoint is paper-only. Any non-PAPER global mode blocks new intents.
    halted: executionMode !== "PAPER",
    maxMarketDataAgeMs: 5_000,
    maxDailyLoss,
    dailyLoss: "0"
  } as const;
}
const paperTradePolicy = resolvePaperTradePolicy(env.EXECUTION_MODE, env.PAPER_MAX_ORDER_NOTIONAL, env.PAPER_MAX_DAILY_LOSS);
const DEFAULT_CACHE_TTL_MS = 1_000;
const MAX_CACHE_ENTRIES = 500;

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-registration-token", "*.privateKey", "*.secret"]
    },
    requestIdHeader: "x-correlation-id"
  });
  const now = options.now ?? Date.now;
  const ownsRateLimitStore = options.rateLimitStore === undefined;
  const rateLimitStore = options.rateLimitStore === undefined ? createDefaultRateLimitStore(now) : options.rateLimitStore;
  const rateLimitReadLimit = options.rateLimitReadLimit ?? 120;
  const rateLimitWriteLimit = options.rateLimitWriteLimit ?? 30;
  const rateLimitWindowSeconds = options.rateLimitWindowSeconds ?? 60;
  if (![rateLimitReadLimit, rateLimitWriteLimit, rateLimitWindowSeconds].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Rate-limit values must be positive integers.");
  }
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
  const workerProbe = options.workerProbe === undefined
    ? (prismaClient && env.NODE_ENV !== "test" ? createDefaultWorkerProbe(prismaClient) : null)
    : options.workerProbe;
  const cacheTtlMs = options.marketCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const polymarketMarketProvider = options.polymarketMarketProvider ?? new PolymarketReadOnlyDiscoveryAdapter({ now });
  const marketCache = new Map<string, { snapshot: MarketSnapshot; expiresAt: number }>();
  const inFlight = new Map<string, Promise<MarketSnapshot>>();

  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60_000) {
    throw new Error("marketCacheTtlMs must be an integer between 0 and 60000.");
  }

  app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    if (!rateLimitStore) {
      return reply.code(503).send({
        error: { code: "RATE_LIMIT_UNAVAILABLE", message: "The API rate-limit store is unavailable.", correlationId: request.id, retryable: true }
      });
    }
    const readOnly = request.method === "GET" || request.method === "HEAD";
    const limit = readOnly ? rateLimitReadLimit : rateLimitWriteLimit;
    const bucket = readOnly ? "read" : "write";
    const digest = createHash("sha256").update(`${request.ip}:${bucket}`).digest("hex").slice(0, 32);
    try {
      const count = await rateLimitStore.consume(`satn:rate:v1:${digest}`, rateLimitWindowSeconds);
      reply.header("x-ratelimit-limit", String(limit));
      reply.header("x-ratelimit-remaining", String(Math.max(0, limit - count)));
      if (count > limit) {
        reply.header("retry-after", String(rateLimitWindowSeconds));
        return reply.code(429).send({
          error: { code: "RATE_LIMITED", message: "The request rate limit has been exceeded.", correlationId: request.id, retryable: true }
        });
      }
    } catch {
      return reply.code(503).send({
        error: { code: "RATE_LIMIT_UNAVAILABLE", message: "The API rate-limit store is unavailable.", correlationId: request.id, retryable: true }
      });
    }
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      databaseProbe?.close(), queueProbe?.close(), workerProbe?.close(),
      ownsRateLimitStore ? rateLimitStore?.close() : undefined
    ]);
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
    const ownerAuth = await resolveOwnerIdentity(request.headers.authorization, request.headers["x-registration-token"]);
    if ("error" in ownerAuth) {
      const failure = ownerAuthFailure(ownerAuth.error, request.id);
      return reply.code(failure.statusCode).send(failure.body);
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
    const authSubject = ownerAuth.subject;
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
              create: { secretHash, scopes: ["journal:write", "trade-intent:write"] }
            }
          },
          select: { id: true, name: true, description: true, status: true, mode: true, version: true, createdAt: true }
        });
        await tx.auditEvent.create({
          data: {
            actorType: ownerAuth.actorType,
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
          scopes: ["journal:write", "trade-intent:write"],
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

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/credentials/rotate", async (request, reply) => {
    const parsedId = uuidSchema.safeParse(request.params.agentId);
    if (!parsedId.success) {
      return reply.code(400).send({
        error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
      });
    }
    const ownerAuth = await resolveOwnerIdentity(request.headers.authorization, request.headers["x-registration-token"]);
    if ("error" in ownerAuth) {
      const failure = ownerAuthFailure(ownerAuth.error, request.id);
      return reply.code(failure.statusCode).send(failure.body);
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Credential rotation is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }

    const authSubject = ownerAuth.subject;
    try {
      const agent = await prismaClient.agent.findUnique({
        where: { id: parsedId.data },
        select: { id: true, owner: { select: { authSubject: true } } }
      });
      if (!agent || agent.owner.authSubject !== authSubject) {
        return reply.code(404).send({
          error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
        });
      }

      const token = `satn_agent_${randomBytes(32).toString("base64url")}`;
      const secretHash = createHash("sha256").update(token).digest("hex");
      const result = await prismaClient.$transaction(async (tx) => {
        await tx.agentCredential.updateMany({
          where: { agentId: parsedId.data, revokedAt: null },
          data: { revokedAt: new Date(now()) }
        });
        const credential = await tx.agentCredential.create({
          data: {
            agentId: parsedId.data,
            secretHash,
            scopes: ["journal:write", "trade-intent:write"]
          },
          select: { id: true, scopes: true, createdAt: true }
        });
        await tx.auditEvent.create({
          data: {
            actorType: ownerAuth.actorType,
            actorId: authSubject,
            action: "agent.credentials_rotated",
            targetType: "Agent",
            targetId: parsedId.data,
            correlationId: request.id,
            payloadHash: createHash("sha256").update(JSON.stringify({ agentId: parsedId.data, action: "rotate" })).digest("hex")
          }
        });
        return credential;
      });
      return reply.code(201).send({
        credential: { ...result, token, warning: "This token is shown once. Previous agent credentials have been revoked." }
      });
    } catch (error) {
      request.log.error({ err: error, correlationId: request.id }, "credential rotation failed");
      return reply.code(503).send({
        error: { code: "CREDENTIAL_ROTATION_FAILED", message: "Credential rotation could not be completed.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/credentials/revoke", async (request, reply) => {
    const parsedId = uuidSchema.safeParse(request.params.agentId);
    if (!parsedId.success) {
      return reply.code(400).send({
        error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
      });
    }
    const ownerAuth = await resolveOwnerIdentity(request.headers.authorization, request.headers["x-registration-token"]);
    if ("error" in ownerAuth) {
      const failure = ownerAuthFailure(ownerAuth.error, request.id);
      return reply.code(failure.statusCode).send(failure.body);
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Credential revocation is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }

    const authSubject = ownerAuth.subject;
    try {
      const agent = await prismaClient.agent.findUnique({
        where: { id: parsedId.data },
        select: { id: true, owner: { select: { authSubject: true } } }
      });
      if (!agent || agent.owner.authSubject !== authSubject) {
        return reply.code(404).send({
          error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
        });
      }
      const result = await prismaClient.$transaction(async (tx) => {
        const revoked = await tx.agentCredential.updateMany({
          where: { agentId: parsedId.data, revokedAt: null },
          data: { revokedAt: new Date(now()) }
        });
        await tx.auditEvent.create({
          data: {
            actorType: ownerAuth.actorType,
            actorId: authSubject,
            action: "agent.credentials_revoked",
            targetType: "Agent",
            targetId: parsedId.data,
            correlationId: request.id,
            payloadHash: createHash("sha256").update(JSON.stringify({ agentId: parsedId.data, action: "revoke" })).digest("hex")
          }
        });
        return revoked.count;
      });
      return reply.send({ agentId: parsedId.data, revokedCount: result });
    } catch (error) {
      request.log.error({ err: error, correlationId: request.id }, "credential revocation failed");
      return reply.code(503).send({
        error: { code: "CREDENTIAL_REVOCATION_FAILED", message: "Credential revocation could not be completed.", correlationId: request.id, retryable: true }
      });
    }
  });

  const setAgentStatus = (targetStatus: "ACTIVE" | "PAUSED") =>
    async (request: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply) => {
      const parsedId = uuidSchema.safeParse(request.params.agentId);
      if (!parsedId.success) {
        return reply.code(400).send({
          error: { code: "INVALID_AGENT_ID", message: "The agent identifier is invalid.", correlationId: request.id, retryable: false }
        });
      }
      const ownerAuth = await resolveOwnerIdentity(request.headers.authorization, request.headers["x-registration-token"]);
      if ("error" in ownerAuth) {
        const failure = ownerAuthFailure(ownerAuth.error, request.id);
        return reply.code(failure.statusCode).send(failure.body);
      }
      if (!prismaClient) {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent lifecycle controls are temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }
      const authSubject = ownerAuth.subject;
      try {
        const agent = await prismaClient.agent.findUnique({
          where: { id: parsedId.data },
          select: { id: true, status: true, owner: { select: { authSubject: true } } }
        });
        if (!agent || agent.owner.authSubject !== authSubject) {
          return reply.code(404).send({
            error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
          });
        }
        if (agent.status === "REVOKED" || agent.status === "DISABLED") {
          return reply.code(409).send({
            error: { code: "AGENT_TERMINAL_STATE", message: "A revoked or disabled agent cannot be resumed or paused.", correlationId: request.id, retryable: false }
          });
        }
        if (agent.status === targetStatus) {
          return reply.send({ agentId: agent.id, status: agent.status, changed: false });
        }
        const result = await prismaClient.$transaction(async (tx) => {
          const updated = await tx.agent.update({
            where: { id: parsedId.data },
            data: { status: targetStatus },
            select: { id: true, status: true, updatedAt: true }
          });
          await tx.auditEvent.create({
            data: {
              actorType: ownerAuth.actorType,
              actorId: authSubject,
              action: targetStatus === "PAUSED" ? "agent.paused" : "agent.resumed",
              targetType: "Agent",
              targetId: parsedId.data,
              correlationId: request.id,
              payloadHash: createHash("sha256").update(JSON.stringify({ agentId: parsedId.data, status: targetStatus })).digest("hex")
            }
          });
          return updated;
        });
        return reply.send({ agentId: result.id, status: result.status, updatedAt: result.updatedAt, changed: true });
      } catch (error) {
        request.log.error({ err: error, correlationId: request.id }, "agent lifecycle update failed");
        return reply.code(503).send({
          error: { code: "AGENT_LIFECYCLE_UPDATE_FAILED", message: "The agent lifecycle update could not be completed.", correlationId: request.id, retryable: true }
        });
      }
    };

  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/pause", setAgentStatus("PAUSED"));
  app.post<{ Params: { agentId: string } }>("/v1/agents/:agentId/resume", setAgentStatus("ACTIVE"));

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

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/trades", async (request, reply) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: "INVALID_QUERY", message: "The trade-feed pagination query is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The public paper-trade feed is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
    try {
      const { limit, cursor } = query.data;
      if (cursor) {
        const cursorRow = await prismaClient.tradeIntent.findUnique({
          where: { id: cursor },
          select: { id: true, mode: true, agent: { select: { status: true, mode: true } } }
        });
        if (
          !cursorRow ||
          cursorRow.mode !== "PAPER" ||
          cursorRow.agent.status !== "ACTIVE" ||
          cursorRow.agent.mode !== "PAPER"
        ) {
          return reply.code(400).send({
            error: { code: "INVALID_CURSOR", message: "The trade-feed cursor is invalid.", correlationId: request.id, retryable: false }
          });
        }
      }

      const rows = await prismaClient.tradeIntent.findMany({
        where: {
          mode: "PAPER",
          agent: { is: { status: "ACTIVE", mode: "PAPER" } }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          venue: true,
          instrument: true,
          side: true,
          orderType: true,
          quantity: true,
          limitPrice: true,
          status: true,
          createdAt: true,
          agent: { select: { id: true, name: true, mode: true } },
          riskDecision: { select: { outcome: true, reasonCodes: true, policyVersion: true, evaluatedAt: true } },
          venueOrder: {
            select: {
              state: true,
              fills: { select: { price: true, quantity: true, fee: true, feeAsset: true, filledAt: true } }
            }
          }
        }
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        ...row,
        provenance: row.venueOrder ? "SIMULATED" as const : "NOT_EXECUTED" as const
      }));
      return reply.send({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
    } catch {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The public paper-trade feed is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/agents", async (request, reply) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: { code: "INVALID_QUERY", message: "The agent-directory pagination query is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The agent directory is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
    try {
      const { limit, cursor } = query.data;
      if (cursor) {
        const cursorAgent = await prismaClient.agent.findUnique({
          where: { id: cursor },
          select: { id: true, status: true }
        });
        if (!cursorAgent || cursorAgent.status !== "ACTIVE") {
          return reply.code(400).send({
            error: { code: "INVALID_CURSOR", message: "The agent-directory cursor is invalid.", correlationId: request.id, retryable: false }
          });
        }
      }
      const rows = await prismaClient.agent.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, name: true, description: true, status: true, mode: true, version: true, createdAt: true, updatedAt: true,
          _count: {
            select: {
              journals: { where: { publishedAt: { not: null } } },
              tradeIntents: true,
              strategies: true
            }
          }
        }
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        mode: agent.mode,
        version: agent.version,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        journalCount: agent._count.journals,
        tradeIntentCount: agent._count.tradeIntents,
        strategyVersionCount: agent._count.strategies
      }));
      return reply.send({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
    } catch {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "The agent directory is temporarily unavailable.", correlationId: request.id, retryable: true }
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
      if (!agent || agent.status !== "ACTIVE") {
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
        if (!agent || agent.status !== "ACTIVE") {
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
      const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), mode: z.enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED"]).default("PAPER") });
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
        if (!agent || agent.status !== "ACTIVE") {
          return reply.code(404).send({
            error: { code: "AGENT_NOT_FOUND", message: "The agent does not exist.", correlationId: request.id, retryable: false }
          });
        }
        const snapshots = await prismaClient.performanceSnapshot.findMany({
          where: { agentId: parsedId.data, mode: query.data.mode },
          orderBy: [{ windowEnd: "desc" }, { calculatedAt: "desc" }],
          take: query.data.limit,
          select: {
            id: true, mode: true, provenance: true, windowStart: true, windowEnd: true,
            methodologyVersion: true, pnlNet: true, maxDrawdown: true, sampleSize: true,
            qualityFlags: true, calculatedAt: true
          }
        });
        const paperFills = query.data.mode === "PAPER"
          ? await prismaClient.fill.findMany({
              where: {
                venueOrder: {
                  is: {
                    intent: { is: { agentId: parsedId.data, mode: "PAPER" } }
                  }
                }
              },
              orderBy: [{ filledAt: "asc" }, { id: "asc" }],
              select: {
                price: true,
                quantity: true,
                fee: true,
                feeAsset: true,
                filledAt: true,
                venueOrder: {
                  select: {
                    intent: { select: { instrument: true, side: true } }
                  }
                }
              }
            })
          : [];
        const summary = query.data.mode === "PAPER"
          ? calculatePaperPerformance(paperFills.map((fill) => ({
              instrument: fill.venueOrder.intent.instrument,
              side: fill.venueOrder.intent.side,
              quantity: fill.quantity.toString(),
              price: fill.price.toString(),
              fee: fill.fee.toString(),
              feeAsset: fill.feeAsset,
              filledAt: fill.filledAt.toISOString()
            })))
          : null;
        return reply.send({ agentId: parsedId.data, summary, items: snapshots });
      } catch {
        return reply.code(503).send({
          error: { code: "DATA_STORE_UNAVAILABLE", message: "Agent performance is temporarily unavailable.", correlationId: request.id, retryable: true }
        });
      }
    }
  );

  app.post("/v1/trade-intents", async (request, reply) => {
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotency = idempotencyKeySchema.safeParse(idempotencyHeader);
    if (!idempotency.success) {
      return reply.code(400).send({
        error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide a valid Idempotency-Key header.", correlationId: request.id, retryable: false }
      });
    }
    const parsed = TradeIntentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_TRADE_INTENT", message: "The trade intent is invalid.", correlationId: request.id, retryable: false }
      });
    }
    if (parsed.data.mode !== "PAPER" || parsed.data.orderType !== "LIMIT") {
      return reply.code(422).send({
        error: { code: "PAPER_LIMIT_ORDERS_ONLY", message: "Only LIMIT orders in PAPER mode are supported by this endpoint.", correlationId: request.id, retryable: false }
      });
    }
    if (parsed.data.venue !== "hyperliquid") {
      return reply.code(422).send({
        error: { code: "VENUE_NOT_SUPPORTED", message: "This paper endpoint currently supports Hyperliquid market snapshots only.", correlationId: request.id, retryable: false }
      });
    }
    if (!prismaClient) {
      return reply.code(503).send({
        error: { code: "DATA_STORE_UNAVAILABLE", message: "Trade-intent persistence is temporarily unavailable.", correlationId: request.id, retryable: true }
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
          agent: { select: { status: true, mode: true } }
        }
      });
      if (
        !credential ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= new Date(now())) ||
        credential.agent.status !== "ACTIVE" ||
        !credential.scopes.includes("trade-intent:write")
      ) {
        return reply.code(401).send({
          error: { code: "INVALID_AGENT_CREDENTIAL", message: "The agent credential is invalid or lacks permission.", correlationId: request.id, retryable: false }
        });
      }
      if (credential.agent.mode !== "PAPER") {
        return reply.code(403).send({
          error: { code: "AGENT_MODE_FORBIDDEN", message: "Trade-intent writes are restricted to PAPER-mode agents.", correlationId: request.id, retryable: false }
        });
      }

      const intentData = parsed.data;
      const payloadHash = createHash("sha256").update(JSON.stringify(intentData)).digest("hex");
      const existing = await prismaClient.tradeIntent.findUnique({
        where: { agentId_idempotencyKey: { agentId: credential.agentId, idempotencyKey: idempotency.data } },
        include: { riskDecision: true, venueOrder: { include: { fills: true } } }
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return reply.code(409).send({
            error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was already used for a different request.", correlationId: request.id, retryable: false }
          });
        }
        return reply.code(200).send({ replayed: true, intent: existing });
      }

      let snapshot: MarketSnapshot;
      try {
        snapshot = await marketDataProvider.getMarketSnapshot(intentData.instrument);
      } catch {
        return reply.code(502).send({
          error: { code: "MARKET_DATA_UNAVAILABLE", message: "A current market snapshot could not be obtained; no intent was persisted.", correlationId: request.id, retryable: true }
        });
      }
      if (
        snapshot.venue !== intentData.venue ||
        snapshot.instrumentId !== intentData.instrument ||
        !snapshot.bid ||
        !snapshot.ask
      ) {
        return reply.code(502).send({
          error: { code: "INVALID_MARKET_SNAPSHOT", message: "The market-data adapter returned an incomplete or mismatched snapshot.", correlationId: request.id, retryable: true }
        });
      }

      const observedMs = Date.parse(snapshot.observedAt);
      const observedAgeMs = Number.isFinite(observedMs) ? now() - observedMs : Number.POSITIVE_INFINITY;
      const policyBase = {
        ...paperTradePolicy,
        marketDataAgeMs: snapshot.dataQuality === "LIVE" && observedAgeMs >= 0
          ? observedAgeMs
          : paperTradePolicy.maxMarketDataAgeMs + 1
      };
      // Preliminary evaluation is repeated under an owning-agent row lock
      // inside the write transaction before any order is stored.
      let policy = { ...policyBase, dailyLoss: "0" };
      let decision = evaluateTradeIntent(intentData, policy, "paper-default-v1");
      let simulatedAt = now();
      let simulation: ReturnType<typeof simulateLimitOrder> | null = null;
      if (decision.allowed) {
        try {
          simulation = simulateLimitOrder({
            side: intentData.side,
            quantity: intentData.quantity,
            ...(intentData.limitPrice !== undefined ? { limitPrice: intentData.limitPrice } : {}),
            feeBps: 10
          }, {
            venue: snapshot.venue,
            instrumentId: snapshot.instrumentId,
            observedAt: snapshot.observedAt,
            bid: snapshot.bid,
            ask: snapshot.ask,
            dataQuality: snapshot.dataQuality
          }, { nowMs: simulatedAt, maxSnapshotAgeMs: paperTradePolicy.maxMarketDataAgeMs });
        } catch {
          return reply.code(422).send({
            error: { code: "PAPER_SIMULATION_REJECTED", message: "The paper engine rejected the market snapshot; no order was simulated.", correlationId: request.id, retryable: false }
          });
        }
      }

      try {
        const result = await prismaClient.$transaction(async (tx) => {
          // Lock the owning agent row until commit/rollback so concurrent
          // paper intents for this agent re-check loss against committed fills.
          await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Agent" WHERE "id" = ${credential.agentId}::uuid FOR UPDATE`;

          const utcDayStart = new Date(now());
          utcDayStart.setUTCHours(0, 0, 0, 0);
          const ledgerFills = await tx.fill.findMany({
            where: { venueOrder: { is: { intent: { is: { agentId: credential.agentId, mode: "PAPER" } } } } },
            orderBy: [{ filledAt: "asc" }, { id: "asc" }],
            select: {
              price: true, quantity: true, fee: true, feeAsset: true, filledAt: true,
              venueOrder: { select: { intent: { select: { instrument: true, side: true } } } }
            }
          });
          const dailyLoss = calculatePaperDailyLoss(ledgerFills.map((fill) => ({
            instrument: fill.venueOrder.intent.instrument,
            side: fill.venueOrder.intent.side,
            quantity: fill.quantity.toString(),
            price: fill.price.toString(),
            fee: fill.fee.toString(),
            feeAsset: fill.feeAsset,
            filledAt: fill.filledAt.toISOString()
          })), utcDayStart.toISOString()).dailyLoss;
          policy = { ...policyBase, dailyLoss };
          decision = evaluateTradeIntent(intentData, policy, "paper-default-v1");
          if (decision.allowed && !simulation) {
            simulatedAt = now();
            simulation = simulateLimitOrder({
              side: intentData.side,
              quantity: intentData.quantity,
              ...(intentData.limitPrice !== undefined ? { limitPrice: intentData.limitPrice } : {}),
              feeBps: 10
            }, {
              venue: snapshot.venue,
              instrumentId: snapshot.instrumentId,
              observedAt: snapshot.observedAt,
              bid: snapshot.bid,
              ask: snapshot.ask,
              dataQuality: snapshot.dataQuality
            }, { nowMs: simulatedAt, maxSnapshotAgeMs: paperTradePolicy.maxMarketDataAgeMs });
          }
          const created = await tx.tradeIntent.create({
            data: {
              agentId: credential.agentId,
              venue: intentData.venue,
              instrument: intentData.instrument,
              side: intentData.side,
              orderType: intentData.orderType,
              quantity: intentData.quantity,
              ...(intentData.limitPrice !== undefined ? { limitPrice: intentData.limitPrice } : {}),
              mode: "PAPER",
              idempotencyKey: idempotency.data,
              payloadHash,
              status: decision.allowed ? (simulation?.status === "FILLED" ? "FILLED" : "OPEN") : "RISK_REJECTED"
            }
          });
          const risk = await tx.riskDecision.create({
            data: {
              intentId: created.id,
              outcome: decision.allowed ? "APPROVED" : "REJECTED",
              reasonCodes: decision.reasons,
              policyVersion: 1
            }
          });
          let venueOrder = null;
          if (decision.allowed && simulation) {
            venueOrder = await tx.venueOrder.create({
              data: {
                intentId: created.id,
                venue: intentData.venue,
                clientOrderId: `satn-paper-${created.id}`,
                venueOrderId: `paper-${created.id}`,
                state: simulation.status === "FILLED" ? "FILLED" : "OPEN",
                submittedAt: new Date(simulatedAt),
                ...(simulation.status === "FILLED" && simulation.fillPrice !== null ? {
                  fills: {
                    create: {
                      fillRef: `paper-fill-${created.id}`,
                      price: simulation.fillPrice,
                      quantity: simulation.quantity,
                      fee: simulation.fee,
                      feeAsset: "USD",
                      filledAt: new Date(simulatedAt)
                    }
                  }
                } : {})
              },
              include: { fills: true }
            });
          }
          await tx.auditEvent.create({
            data: {
              actorType: "AGENT_CREDENTIAL",
              actorId: credential.id,
              action: !decision.allowed ? "trade_intent.risk_rejected" : simulation?.status === "FILLED" ? "paper_order.filled" : "paper_order.open",
              targetType: "TradeIntent",
              targetId: created.id,
              correlationId: request.id,
              payloadHash
            }
          });
          return { intent: created, riskDecision: risk, venueOrder };
        });
        if (!decision.allowed) {
          return reply.code(422).send({
            ...result,
            error: { code: "RISK_REJECTED", message: "The paper trade was rejected by the deterministic risk policy.", reasons: decision.reasons, correlationId: request.id, retryable: false }
          });
        }
        return reply.code(201).send({ ...result, simulation, replayed: false });
      } catch (error) {
        // A concurrent retry may win the unique idempotency constraint.
        const raced = await prismaClient.tradeIntent.findUnique({
          where: { agentId_idempotencyKey: { agentId: credential.agentId, idempotencyKey: idempotency.data } },
          include: { riskDecision: true, venueOrder: { include: { fills: true } } }
        }).catch(() => null);
        if (raced) {
          if (raced.payloadHash !== payloadHash) {
            return reply.code(409).send({
              error: { code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was already used for a different request.", correlationId: request.id, retryable: false }
            });
          }
          return reply.code(200).send({ replayed: true, intent: raced });
        }
        request.log.error({ err: error, correlationId: request.id }, "paper trade persistence failed");
        return reply.code(503).send({
          error: { code: "TRADE_INTENT_PERSISTENCE_FAILED", message: "The paper trade could not be persisted.", correlationId: request.id, retryable: true }
        });
      }
    } catch (error) {
      request.log.error({ err: error, correlationId: request.id }, "trade-intent request failed");
      return reply.code(503).send({
        error: { code: "TRADE_INTENT_UNAVAILABLE", message: "Trade-intent processing is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
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

  app.get<{ Querystring: { venue?: string; limit?: string; offset?: string } }>("/v1/markets", async (request, reply) => {
    const querySchema = z.object({
      venue: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      offset: z.coerce.number().int().min(0).max(10_000).default(0)
    }).strict();
    const query = querySchema.safeParse(request.query);
    if (!query.success || !query.data.venue) {
      return reply.code(400).send({
        error: { code: "INVALID_QUERY", message: "Provide venue=polymarket and valid pagination.", correlationId: request.id, retryable: false }
      });
    }
    if (query.data.venue !== "polymarket") {
      return reply.code(422).send({
        error: { code: "VENUE_DISCOVERY_UNSUPPORTED", message: "Read-only market discovery is currently implemented for Polymarket only.", correlationId: request.id, retryable: false }
      });
    }
    try {
      return reply.send(await polymarketMarketProvider.listMarkets({ limit: query.data.limit, offset: query.data.offset }));
    } catch {
      return reply.code(502).send({
        error: { code: "MARKET_DISCOVERY_UNAVAILABLE", message: "Polymarket market discovery is temporarily unavailable.", correlationId: request.id, retryable: true }
      });
    }
  });

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
