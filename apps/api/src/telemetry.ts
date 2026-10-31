import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Stage-one SATNS OpenTelemetry API tracing.
 *
 * Sentry v11 provides the light OpenTelemetry tracer provider only when the
 * operator opts in. No standalone OTLP exporter or automatic instrumentation
 * is installed, so no default request/URL/body/identity data is captured.
 */
export function telemetryEnabled(
  env: {
    SATNS_OTEL_ENABLED?: string;
    SENTRY_DSN?: string;
    NODE_ENV?: string;
  } = process.env,
): boolean {
  return (
    env.SATNS_OTEL_ENABLED === "true" &&
    Boolean(env.SENTRY_DSN) &&
    env.NODE_ENV !== "test"
  );
}

const methodAllowlist = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

// Only literals from the reviewed SATNS Fastify routing surface are exposed.
// A route that accidentally contains a real ID/token is always "unmatched".
const staticRouteSegments = new Set([
  "health",
  "live",
  "ready",
  "v1",
  "agents",
  "credentials",
  "rotate",
  "revoke",
  "pause",
  "resume",
  "journal",
  "feed",
  "trades",
  "follows",
  "following",
  "followers",
  "posts",
  "replies",
  "likes",
  "home-feed",
  "reports",
  "moderation",
  "visibility",
  "portfolio",
  "performance",
  "trade-intents",
  "venues",
  "markets",
  "market",
  "network",
  "stats",
  "my-votes",
  "communities",
  "comments",
  "vote",
  "subscribe",
  "owners",
  "me",
  "agent-registrations",
  "status",
  "preview",
  "claim",
  "activate",
]);

export function safeRouteTemplate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 120 ||
    !value.startsWith("/")
  )
    return "unmatched";
  if (value === "/") return "/";
  const segments = value.slice(1).split("/");
  return segments.every(
    (segment) =>
      staticRouteSegments.has(segment) ||
      /^:[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(segment),
  )
    ? value
    : "unmatched";
}

function safeMethod(value: unknown): string {
  return typeof value === "string" && methodAllowlist.has(value)
    ? value
    : "OTHER";
}

export function registerHttpTelemetry(
  app: FastifyInstance,
  {
    enabled = telemetryEnabled(),
    tracer = trace.getTracer("satns.api", "0.1.0"),
    meter = metrics.getMeter("satns.api", "0.1.0"),
    now = () => performance.now(),
  }: {
    enabled?: boolean;
    tracer?: Tracer;
    meter?: Meter;
    now?: () => number;
  } = {},
): void {
  if (!enabled) return;

  // OpenTelemetry Meter API remains a no-op until an independently approved
  // MeterProvider/exporter is installed. Do not enable implicit network export.
  let requestDuration: Histogram | undefined;
  try {
    requestDuration = meter.createHistogram("http.server.request.duration", {
      unit: "s",
      description: "SATNS inbound HTTP request duration",
    });
  } catch {
    // Telemetry registration must never prevent the API from starting.
  }

  const startedAt = new WeakMap<FastifyRequest, number>();
  const activeSpans = new WeakMap<FastifyRequest, Span>();
  app.addHook("onRequest", async (request) => {
    try {
      const timestamp = now();
      if (Number.isFinite(timestamp)) startedAt.set(request, timestamp);
    } catch {
      // The monotonic clock is an optional observational dependency.
    }
    try {
      activeSpans.set(
        request,
        tracer.startSpan("satns.http.request", {
          kind: SpanKind.SERVER,
          attributes: { "http.request.method": safeMethod(request.method) },
        }),
      );
    } catch {
      // Monitoring must never block an API request or risk halt.
    }
  });
  app.addHook("onError", async (request) => {
    try {
      activeSpans.get(request)?.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Exception payloads are intentionally never copied to spans.
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    // Both spans and duration measurements use identical low-cardinality
    // attributes. Never pass through request headers, URLs or identities.
    const attributes = {
      "http.request.method": safeMethod(request.method),
      "http.route": safeRouteTemplate(request.routeOptions.url),
      "http.response.status_code": reply.statusCode,
    };
    const started = startedAt.get(request);
    startedAt.delete(request);
    if (started !== undefined && requestDuration) {
      try {
        const seconds = (now() - started) / 1000;
        if (Number.isFinite(seconds) && seconds >= 0)
          requestDuration.record(seconds, attributes);
      } catch {
        // A misconfigured metrics provider is never a request dependency.
      }
    }

    const span = activeSpans.get(request);
    if (!span) return;
    activeSpans.delete(request);
    try {
      span.setAttribute("http.route", attributes["http.route"]);
      span.setAttribute(
        "http.response.status_code",
        attributes["http.response.status_code"],
      );
      if (reply.statusCode >= 500)
        span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Invalid exporter/provider must not change HTTP results.
    } finally {
      try {
        span.end();
      } catch {
        // Fail open for telemetry, not for application authorization.
      }
    }
  });
}

const workerOperations = new Set([
  "satns.worker.system.healthcheck",
  "satns.worker.queue.stats",
  "satns.worker.heartbeat",
]);
export type WorkerOperation =
  | "satns.worker.system.healthcheck"
  | "satns.worker.queue.stats"
  | "satns.worker.heartbeat";

export async function withWorkerSpan<T>(
  operation: WorkerOperation,
  work: () => Promise<T>,
  {
    enabled = telemetryEnabled(),
    tracer = trace.getTracer("satns.worker", "0.1.0"),
  }: { enabled?: boolean; tracer?: Tracer } = {},
): Promise<T> {
  if (!enabled || !workerOperations.has(operation)) return work();

  let span: Span;
  try {
    span = tracer.startSpan(operation, { kind: SpanKind.INTERNAL });
  } catch {
    return work();
  }
  try {
    return await work();
  } catch (error) {
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Preserve the original worker error.
    }
    throw error;
  } finally {
    try {
      span.end();
    } catch {
      // Telemetry never changes worker execution results.
    }
  }
}
