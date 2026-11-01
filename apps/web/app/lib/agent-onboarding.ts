import { humanAuthReady } from "./human-auth-ready";

/** Public discovery only. Never fall back to a private backend address. */
export function agentOnboardingConfig() {
  let apiOrigin: string | null = null;
  try {
    const api = new URL(process.env.NEXT_PUBLIC_SATN_API_URL ?? "");
    const web = new URL(process.env.AUTH_PUBLIC_ORIGIN ?? "");
    if (
      humanAuthReady() &&
      api.protocol === "https:" &&
      api.origin !== web.origin &&
      !api.username &&
      !api.password &&
      api.pathname === "/" &&
      !api.search &&
      !api.hash
    ) {
      apiOrigin = api.origin;
    }
  } catch {
    // Missing or malformed deployment configuration keeps onboarding closed.
  }
  return {
    registration_configured: apiOrigin !== null,
    api_origin: apiOrigin,
    readiness: "not_checked" as const,
    health_path: "/health/ready",
    guide: "/get-started.md",
    initial_scopes: ["journal:write", "social:write"],
    live_trading_enabled: false,
  };
}
