import * as Sentry from "@sentry/node";
import { minimalSentryError } from "./sentry-privacy.js";
import { telemetryEnabled } from "./telemetry.js";

const active =
  Boolean(process.env.SENTRY_DSN) && process.env.NODE_ENV !== "test";
const tracingEnabled = telemetryEnabled();
if (active) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // Disabled unless the operator explicitly enables low-sampled OTEL API
    // spans. Sentry v11 registers a light provider without OTLP export.
    enableOpenTelemetrySetup: tracingEnabled,
    tracesSampleRate: tracingEnabled ? 0.02 : 0,
    defaultIntegrations: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}

export function captureBackendException(error: unknown): void {
  if (active) Sentry.captureException(error);
}
