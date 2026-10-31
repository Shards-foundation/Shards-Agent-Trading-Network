import * as Sentry from "@sentry/node";
import { minimalSentryError } from "./sentry-privacy.js";

const active =
  Boolean(process.env.SENTRY_DSN) && process.env.NODE_ENV !== "test";
if (active) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    autoSessionTracking: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}

export function captureBackendException(error: unknown): void {
  if (active) Sentry.captureException(error);
}
