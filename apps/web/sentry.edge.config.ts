import * as Sentry from "@sentry/nextjs";
import { minimalSentryError } from "./sentry-privacy";

const dsn = process.env.SENTRY_DSN;
if (dsn && process.env.NODE_ENV !== "test") {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    autoSessionTracking: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}
