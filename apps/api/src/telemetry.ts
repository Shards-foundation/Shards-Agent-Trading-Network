import {
  SpanKind,
  SpanStatusCode,
  trace,
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
  env: Pick<NodeJS.ProcessEnv, "SATNS_OTEL_ENABLED" | "SENTRY_DSN" | "NODE_ENV"> =
    process.env,
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

export function safeRouteTemplate(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 120 &&
    /^\/[a-zA-Z0-9_./:-]*$/.test(value)
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
  }: { enabled?: boolean; tracer?: Tracer } = {},
): void {
  if (!enabled) return;

  const activeSpans = new WeakMap<FastifyRequest, Span>();
  app.addHook("onRequest", async (request) => {
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
      activeSpans
        .get(request)
        ?.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Exception payloads are intentionally never copied to spans.
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = activeSpans.get(request);
    if (!span) return;
    activeSpans.delete(request);
    try {
      // Use framework route templates only. Never copy request.url, query,
      // cookies, headers, bodies, bearer tokens, actor IDs or journal text.
      span.setAttribute(
        "http.route",
        safeRouteTemplate(request.routeOptions.url),
      );
      span.setAttribute("http.response.status_code", reply.statusCode);
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
