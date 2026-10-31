import * as Sentry from "@sentry/node";
import { minimalSentryError } from "./sentry-privacy.js";

const active =
  Boolean(process.env.SENTRY_DSN) && process.env.NODE_ENV !== "test";
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
    tracesSampleRate: 0,
    defaultIntegrations: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}

export function captureBackendException(error: unknown): void {
  if (active) Sentry.captureException(error);
}
