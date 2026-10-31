import Fastify from "fastify";
import {
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import {
  registerHttpTelemetry,
  safeRouteTemplate,
  telemetryEnabled,
  withWorkerSpan,
} from "./telemetry.js";

function recorder() {
  const spans: Array<{
    name: string;
    kind: SpanKind | undefined;
    attributes: Record<string, string | number>;
    statuses: number[];
    ended: number;
  }> = [];
  const tracer = {
    startSpan(
      name: string,
      options: { kind?: SpanKind; attributes?: Record<string, string> },
    ) {
      const recorded = {
        name,
        kind: options.kind,
        attributes: { ...options.attributes } as Record<
          string,
          string | number
        >,
        statuses: [] as number[],
        ended: 0,
      };
      spans.push(recorded);
      return {
        setAttribute(key: string, value: string | number) {
          recorded.attributes[key] = value;
          return this;
        },
        setStatus(status: { code: number }) {
          recorded.statuses.push(status.code);
          return this;
        },
        end() {
          recorded.ended += 1;
        },
      } as unknown as Span;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

describe("SATNS OpenTelemetry privacy and release gate", () => {
  it("requires exact opt-in plus DSN; disabled in test", () => {
    expect(
      telemetryEnabled({
        SATNS_OTEL_ENABLED: "true",
        SENTRY_DSN: "synthetic",
        NODE_ENV: "production",
      }),
    ).toBe(true);
    expect(
      telemetryEnabled({
        SATNS_OTEL_ENABLED: "1",
        SENTRY_DSN: "synthetic",
        NODE_ENV: "production",
      }),
    ).toBe(false);
    expect(
      telemetryEnabled({
        SATNS_OTEL_ENABLED: "true",
        NODE_ENV: "production",
      }),
    ).toBe(false);
    expect(
      telemetryEnabled({
        SATNS_OTEL_ENABLED: "true",
        SENTRY_DSN: "synthetic",
        NODE_ENV: "test",
      }),
    ).toBe(false);
  });

  it("accepts only static route templates, not raw queries or secrets", () => {
    expect(safeRouteTemplate("/v1/agents/:agentId")).toBe(
      "/v1/agents/:agentId",
    );
    expect(safeRouteTemplate("/health/ready")).toBe("/health/ready");
    expect(safeRouteTemplate("/v1/posts?token=SECRET")).toBe("unmatched");
    expect(safeRouteTemplate("/".repeat(130))).toBe("unmatched");
    expect(safeRouteTemplate(null)).toBe("unmatched");
  });

  it("records only method, template and status, never request data", async () => {
    const app = Fastify();
    const { tracer, spans } = recorder();
    registerHttpTelemetry(app, { enabled: true, tracer });
    app.get("/v1/agents/:agentId", async () => ({ ok: true }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/agents/PRIVATE-AGENT-123?wallet=PRIVATE-WALLET",
        headers: {
          authorization: "Bearer PRIVATE-TOKEN",
          cookie: "session=PRIVATE-COOKIE",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({
        name: "satns.http.request",
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": "GET",
          "http.route": "/v1/agents/:agentId",
          "http.response.status_code": 200,
        },
        statuses: [],
        ended: 1,
      });
      const exported = JSON.stringify(spans);
      for (const privateText of [
        "PRIVATE-AGENT-123",
        "PRIVATE-WALLET",
        "PRIVATE-TOKEN",
        "PRIVATE-COOKIE",
      ]) {
        expect(exported).not.toContain(privateText);
      }
    } finally {
      await app.close();
    }
  });

  it("records failure status but never the exception message", async () => {
    const app = Fastify();
    const { tracer, spans } = recorder();
    registerHttpTelemetry(app, { enabled: true, tracer });
    app.get("/fail/:id", async () => {
      throw new Error("wallet=TOP-SECRET-ERROR");
    });
    try {
      expect((await app.inject("/fail/PRIVATE-IDENTIFIER")).statusCode).toBe(
        500,
      );
      expect(spans).toHaveLength(1);
      expect(spans[0]?.statuses).toContain(SpanStatusCode.ERROR);
      expect(spans[0]?.attributes["http.route"]).toBe("/fail/:id");
      expect(JSON.stringify(spans)).not.toContain("TOP-SECRET-ERROR");
      expect(JSON.stringify(spans)).not.toContain("PRIVATE-IDENTIFIER");
      expect(spans[0]?.ended).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("never blocks a request on telemetry faults", async () => {
    const app = Fastify();
    const startSpan = vi.fn(() => {
      throw new Error("exporter unavailable");
    });
    registerHttpTelemetry(app, {
      enabled: true,
      tracer: { startSpan } as unknown as Tracer,
    });
    app.get("/health/ready", async () => ({ ready: true }));
    try {
      expect((await app.inject("/health/ready")).statusCode).toBe(200);
      expect(startSpan).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("traces approved worker operations and preserves errors", async () => {
    const { tracer, spans } = recorder();
    expect(
      await withWorkerSpan(
        "satns.worker.queue.stats",
        async () => ({ waiting: 2 }),
        { enabled: true, tracer },
      ),
    ).toEqual({ waiting: 2 });
    const privateError = new Error("wallet=SECRET-WORKER-PAYLOAD");
    await expect(
      withWorkerSpan(
        "satns.worker.system.healthcheck",
        async () => {
          throw privateError;
        },
        { enabled: true, tracer },
      ),
    ).rejects.toBe(privateError);
    expect(spans.map((item) => item.name)).toEqual([
      "satns.worker.queue.stats",
      "satns.worker.system.healthcheck",
    ]);
    expect(spans.every((span) => span.ended === 1)).toBe(true);
    expect(spans[1]?.statuses).toContain(SpanStatusCode.ERROR);
    expect(JSON.stringify(spans)).not.toContain(privateError.message);
  });
});
