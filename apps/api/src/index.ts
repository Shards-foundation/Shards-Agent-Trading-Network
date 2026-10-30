import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  calculatePaperDailyLoss,
  calculatePaperPerformance,
  calculatePaperPortfolio,
} from "@satn/accounting";
import { verifyOidcAccessToken } from "@satn/auth";
import { evaluateTradeIntent, TradeIntentSchema } from "@satn/risk";
import { simulateLimitOrder } from "@satn/paper-engine";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { HyperliquidReadOnlyAdapter } from "@satn/venue-adapters/hyperliquid";
import {
  PolymarketReadOnlyDiscoveryAdapter,
  type PolymarketMarketDiscoveryProvider,
} from "@satn/venue-adapters/polymarket";
import type { MarketSnapshot } from "@satn/venue-adapters";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  EXECUTION_MODE: z
    .enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED", "HALTED"])
    .default("PAPER"),
  LIVE_EXECUTION_ENABLED: z.literal("false").default("false"),
  PAPER_MAX_ORDER_NOTIONAL: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/)
    .default("1000"),
  PAPER_MAX_DAILY_LOSS: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/)
    .default("100"),
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
  databaseProbe?
…[1 chars truncated — re-run with head/grep/tail for full output]…
ent.mode !== "PAPER") {
        return reply.code(403).send({
          error: {
            code: "AGENT_MODE_FORBIDDEN",
            message: "Trade-intent writes are restricted to PAPER-mode agents.",
            correlationId: request.id,
            retryable: false,
          },
        });
      }

      const intentData = parsed.data;
      const payloadHash = createHash("sha256")
        .update(JSON.stringify(intentData))
        .digest("hex");
      const existing = await prismaClient.tradeIntent.findUnique({
        where: {
          agentId_idempotencyKey: {
            agentId: credential.agentId,
            idempotencyKey: idempotency.data,
          },
        },
        include: {
          riskDecision: true,
          venueOrder: { include: { fills: true } },
        },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return reply.code(409).send({
            error: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message:
                "This idempotency key was already used for a different request.",
              correlationId: request.id,
              retryable: false,
            },
          });
        }
        return reply.code(200).send({ replayed: true, intent: existing });
      }

      let snapshot: MarketSnapshot;
      try {
        snapshot = await marketDataProvider.getMarketSnapshot(
          intentData.instrument,
        );
      } catch {
        return reply.code(502).send({
          error: {
            code: "MARKET_DATA_UNAVAILABLE",
            message:
              "A current market snapshot could not be obtained; no intent was persisted.",
            correlationId: request.id,
            retryable: true,
          },
        });
      }
      if (
        snapshot.venue !== intentData.venue ||
        snapshot.instrumentId !== intentData.instrument ||
        !snapshot.bid ||
        !snapshot.ask
      ) {
        return reply.code(502).send({
          error: {
            code: "INVALID_MARKET_SNAPSHOT",
            message:
              "The market-data adapter returned an incomplete or mismatched snapshot.",
            correlationId: request.id,
            retryable: true,
          },
        });
      }

      const observedMs = Date.parse(snapshot.observedAt);
      const observedAgeMs = Number.isFinite(observedMs)
        ? now() - observedMs
        : Number.POSITIVE_INFINITY;
      const policyBase = {
        ...paperTradePolicy,
        marketDataAgeMs:
          snapshot.dataQuality === "LIVE" && observedAgeMs >= 0
            ? observedAgeMs
            : paperTradePolicy.maxMarketDataAgeMs + 1,
      };
      // Preliminary evaluation is repeated under an owning-agent row lock
      // inside the write transaction before any order is stored.
      let policy = { ...policyBase, dailyLoss: "0" };
      let decision = evaluateTradeIntent(
        intentData,
        policy,
        "paper-default-v1",
      );
      let simulatedAt = now();
      let simulation: ReturnType<typeof simulateLimitOrder> | null = null;
      if (decision.allowed) {
        try {
          simulation = simulateLimitOrder(
            {
              side: intentData.side,
              quantity: intentData.quantity,
              ...(intentData.limitPrice !== undefined
                ? { limitPrice: intentData.limitPrice }
                : {}),
              feeBps: 10,
            },
            {
              venue: snapshot.venue,
              instrumentId: snapshot.instrumentId,
              observedAt: snapshot.observedAt,
              bid: snapshot.bid,
              ask: snapshot.ask,
              dataQuality: snapshot.dataQuality,
            },
            {
              nowMs: simulatedAt,
              maxSnapshotAgeMs: paperTradePolicy.maxMarketDataAgeMs,
            },
          );
        } catch {
          return reply.code(422).send({
            error: {
              code: "PAPER_SIMULATION_REJECTED",
              message:
                "The paper engine rejected the market snapshot; no order was simulated.",
              correlationId: request.id,
              retryable: false,
            },
          });
        }
      }

      try {
        const result = await prismaClient.$transaction(async (tx) => {
          // Lock the owning agent row until commit/rollback so concurrent
          // paper intents for this agent re-check loss against committed fills.
          await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT "id" FROM "Agent" WHERE "id" = ${credential.agentId}::uuid FOR UPDATE`;

          const utcDayStart = new Date(now());
          utcDayStart.setUTCHours(0, 0, 0, 0);
          const ledgerFills = await tx.fill.findMany({
            where: {
              venueOrder: {
                is: {
                  intent: {
                    is: { agentId: credential.agentId, mode: "PAPER" },
                  },
                },
              },
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
                  intent: { select: { instrument: true, side: true } },
                },
              },
            },
          });
          const dailyLoss = calculatePaperDailyLoss(
            ledgerFills.map((fill) => ({
              instrument: fill.venueOrder.intent.instrument,
              side: fill.venueOrder.intent.side,
              quantity: fill.quantity.toString(),
              price: fill.price.toString(),
              fee: fill.fee.toString(),
              feeAsset: fill.feeAsset,
              filledAt: fill.filledAt.toISOString(),
            })),
            utcDayStart.toISOString(),
          ).dailyLoss;
          policy = { ...policyBase, dailyLoss };
          decision = evaluateTradeIntent(
            intentData,
            policy,
            "paper-default-v1",
          );
          if (decision.allowed && !simulation) {
            simulatedAt = now();
            simulation = simulateLimitOrder(
              {
                side: intentData.side,
                quantity: intentData.quantity,
                ...(intentData.limitPrice !== undefined
                  ? { limitPrice: intentData.limitPrice }
                  : {}),
                feeBps: 10,
              },
              {
                venue: snapshot.venue,
                instrumentId: snapshot.instrumentId,
                observedAt: snapshot.observedAt,
                bid: snapshot.bid,
                ask: snapshot.ask,
                dataQuality: snapshot.dataQuality,
              },
              {
                nowMs: simulatedAt,
                maxSnapshotAgeMs: paperTradePolicy.maxMarketDataAgeMs,
              },
            );
          }
          const created = await tx.tradeIntent.create({
            data: {
              agentId: credential.agentId,
              venue: intentData.venue,
              instrument: intentData.instrument,
              side: intentData.side,
              orderType: intentData.orderType,
              quantity: intentData.quantity,
              ...(intentData.limitPrice !== undefined
                ? { limitPrice: intentData.limitPrice }
                : {}),
              mode: "PAPER",
              idempotencyKey: idempotency.data,
              payloadHash,
              status: decision.allowed
                ? simulation?.status === "FILLED"
                  ? "FILLED"
                  : "OPEN"
                : "RISK_REJECTED",
            },
          });
          const risk = await tx.riskDecision.create({
            data: {
              intentId: created.id,
              outcome: decision.allowed ? "APPROVED" : "REJECTED",
              reasonCodes: decision.reasons,
              policyVersion: 1,
            },
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
                ...(simulation.status === "FILLED" &&
                simulation.fillPrice !== null
                  ? {
                      fills: {
                        create: {
                          fillRef: `paper-fill-${created.id}`,
                          price: simulation.fillPrice,
                          quantity: simulation.quantity,
                          fee: simulation.fee,
                          feeAsset: "USD",
                          filledAt: new Date(simulatedAt),
                        },
                      },
                    }
                  : {}),
              },
              include: { fills: true },
            });
          }
          await tx.auditEvent.create({
            data: {
              actorType: "AGENT_CREDENTIAL",
              actorId: credential.id,
              action: !decision.allowed
                ? "trade_intent.risk_rejected"
                : simulation?.status === "FILLED"
                  ? "paper_order.filled"
                  : "paper_order.open",
              targetType: "TradeIntent",
              targetId: created.id,
              correlationId: request.id,
              payloadHash,
            },
          });
          return { intent: created, riskDecision: risk, venueOrder };
        });
        if (!decision.allowed) {
          return reply.code(422).send({
            ...result,
            error: {
              code: "RISK_REJECTED",
              message:
                "The paper trade was rejected by the deterministic risk policy.",
              reasons: decision.reasons,
              correlationId: request.id,
              retryable: false,
            },
          });
        }
        return reply.code(201).send({ ...result, simulation, replayed: false });
      } catch (error) {
        // A concurrent retry may win the unique idempotency constraint.
        const raced = await prismaClient.tradeIntent
          .findUnique({
            where: {
              agentId_idempotencyKey: {
                agentId: credential.agentId,
                idempotencyKey: idempotency.data,
              },
            },
            include: {
              riskDecision: true,
              venueOrder: { include: { fills: true } },
            },
          })
          .catch(() => null);
        if (raced) {
          if (raced.payloadHash !== payloadHash) {
            return reply.code(409).send({
              error: {
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "This idempotency key was already used for a different request.",
                correlationId: request.id,
                retryable: false,
              },
            });
          }
          return reply.code(200).send({ replayed: true, intent: raced });
        }
        request.log.error(
          { err: error, correlationId: request.id },
          "paper trade persistence failed",
        );
        return reply.code(503).send({
          error: {
            code: "TRADE_INTENT_PERSISTENCE_FAILED",
            message: "The paper trade could not be persisted.",
            correlationId: request.id,
            retryable: true,
          },
        });
      }
    } catch (error) {
      request.log.error(
        { err: error, correlationId: request.id },
        "trade-intent request failed",
      );
      return reply.code(503).send({
        error: {
          code: "TRADE_INTENT_UNAVAILABLE",
          message: "Trade-intent processing is temporarily unavailable.",
          correlationId: request.id,
          retryable: true,
        },
      });
    }
  });

  app.get("/v1/venues", async () => ({
    venues: [
      {
        id: "hyperliquid",
        status: "read-only",
        capabilities: ["market-data", "paper-trading"],
      },
      {
        id: "polymarket",
        status: "planned",
        capabilities: ["market-discovery"],
      },
      {
        id: "pump-fun",
        status: "read-only-review",
        capabilities: ["approved-public-data"],
      },
      { id: "uniswap", status: "planned", capabilities: ["quote-only"] },
    ],
    liveExecutionEnabled: false,
  }));

  app.get<{ Querystring: { venue?: string; limit?: string; offset?: string } }>(
    "/v1/markets",
    async (request, reply) => {
      const querySchema = z
        .object({
          venue: z.string().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          offset: z.coerce.number().int().min(0).max(10_000).default(0),
        })
        .strict();
      const query = querySchema.safeParse(request.query);
      if (!query.success || !query.data.venue) {
        return reply.code(400).send({
          error: {
            code: "INVALID_QUERY",
            message: "Provide venue=polymarket and valid pagination.",
            correlationId: request.id,
            retryable: false,
          },
        });
      }
      if (query.data.venue !== "polymarket") {
        return reply.code(422).send({
          error: {
            code: "VENUE_DISCOVERY_UNSUPPORTED",
            message:
              "Read-only market discovery is currently implemented for Polymarket only.",
            correlationId: request.id,
            retryable: false,
          },
        });
      }
      try {
        return reply.send(
          await polymarketMarketProvider.listMarkets({
            limit: query.data.limit,
            offset: query.data.offset,
          }),
        );
      } catch {
        return reply.code(502).send({
          error: {
            code: "MARKET_DISCOVERY_UNAVAILABLE",
            message: "Polymarket market discovery is temporarily unavailable.",
            correlationId: request.id,
            retryable: true,
          },
        });
      }
    },
  );

  app.get<{ Params: { instrumentId: string } }>(
    "/v1/market/:instrumentId",
    async (request, reply) => {
      const parsed = instrumentSchema.safeParse(request.params.instrumentId);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: "INVALID_INSTRUMENT",
            message: "The instrument identifier is invalid.",
            correlationId: request.id,
            retryable: false,
          },
        });
      }

      const instrumentId = parsed.data;
      const cached = marketCache.get(instrumentId);
      if (cached && cached.expiresAt > now()) {
        return reply
          .header("x-cache", "HIT")
          .send({ snapshot: cached.snapshot });
      }
      marketCache.delete(instrumentId);

      try {
        let pending = inFlight.get(instrumentId);
        if (!pending) {
          pending = marketDataProvider.getMarketSnapshot(instrumentId);
          inFlight.set(instrumentId, pending);
        }
        const snapshot = await pending;
        if (
          snapshot.instrumentId !== instrumentId ||
          snapshot.venue !== "hyperliquid"
        ) {
          throw new Error(
            "Market-data provider returned a mismatched instrument or venue.",
          );
        }

        if (cacheTtlMs > 0) {
          if (
            marketCache.size >= MAX_CACHE_ENTRIES &&
            !marketCache.has(instrumentId)
          ) {
            const oldestKey = marketCache.keys().next().value;
            if (oldestKey !== undefined) marketCache.delete(oldestKey);
          }
          marketCache.set(instrumentId, {
            snapshot,
            expiresAt: now() + cacheTtlMs,
          });
        }
        return reply.header("x-cache", "MISS").send({ snapshot });
      } catch {
        return reply.code(502).send({
          error: {
            code: "MARKET_DATA_UNAVAILABLE",
            message: "Market data is temporarily unavailable.",
            correlationId: request.id,
            retryable: true,
          },
        });
      } finally {
        inFlight.delete(instrumentId);
      }
    },
  );

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource does not exist.",
        retryable: false,
      },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      { err: error, correlationId: request.id },
      "request failed",
    );
    const details: Record<string, unknown> =
      error !== null && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const candidateStatus = details.statusCode;
    const candidateMessage = details.message;
    const status =
      typeof candidateStatus === "number" &&
      candidateStatus >= 400 &&
      candidateStatus < 600
        ? candidateStatus
        : 500;
    const message =
      typeof candidateMessage === "string"
        ? candidateMessage
        : "An unexpected error occurred.";
    return reply.code(status).send({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: status === 500 ? "An unexpected error occurred." : message,
        correlationId: request.id,
        retryable: status >= 500,
      },
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