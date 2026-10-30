import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  EXECUTION_MODE: z.enum(["PAPER", "READ_ONLY", "LIVE_RESTRICTED", "HALTED"]).default("PAPER"),
  LIVE_EXECUTION_ENABLED: z.string().default("false")
});
const env = envSchema.parse(process.env);

export function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", "*.privateKey", "*.secret"]
    },
    requestIdHeader: "x-correlation-id",
    disableRequestLogging: false
  });

  app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });

  app.get("/health/live", async () => ({
    status: "ok",
    service: "satn-api",
    timestamp: new Date().toISOString()
  }));

  app.get("/health/ready", async (_request, reply) => {
    // Until persistent dependencies are wired, this reports process readiness only.
    return reply.code(200).send({
      status: "ready",
      dependencies: { database: "not-configured", redis: "not-configured" },
      execution: {
        mode: env.EXECUTION_MODE,
        liveEnabled: env.LIVE_EXECUTION_ENABLED === "true" && env.EXECUTION_MODE === "LIVE_RESTRICTED"
      }
    });
  });

  app.get("/v1/venues", async () => ({
    venues: [
      { id: "hyperliquid", status: "planned", capabilities: ["market-data", "paper-trading"] },
      { id: "polymarket", status: "planned", capabilities: ["market-discovery"] },
      { id: "pump-fun", status: "read-only-review", capabilities: ["approved-public-data"] },
      { id: "uniswap", status: "planned", capabilities: ["quote-only"] }
    ],
    liveExecutionEnabled: false
  }));

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
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    return reply.code(status).send({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message: status === 500 ? "An unexpected error occurred." : error.message,
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
