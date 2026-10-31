import * as Sentry from "@sentry/nextjs";
import { minimalSentryError } from "./sentry-privacy";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn && process.env.NODE_ENV !== "test") {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    autoSessionTracking: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
