import * as Sentry from "@sentry/nextjs";
import { minimalSentryError } from "./sentry-privacy";

const dsn = process.env.SENTRY_DSN;
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
    autoSessionTracking: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => minimalSentryError(event),
  });
}
