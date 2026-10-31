import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

// Builds remain unchanged without all of these protected variables.
const org = process.env.SENTRY_ORG;
const project = process.env.SENTRY_PROJECT;
const authToken = process.env.SENTRY_AUTH_TOKEN;

export default org && project && authToken
  ? withSentryConfig(nextConfig, {
      org,
      project,
      authToken,
      silent: true,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    })
  : nextConfig;
