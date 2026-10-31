import * as Sentry from "@sentry/nextjs";
import { minimalSentryError } from "./sentry-privacy";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn && process.env.NODE_ENV !== "test") {
  Sentry.init({
    dsn,
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
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    defaultIntegrations: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
