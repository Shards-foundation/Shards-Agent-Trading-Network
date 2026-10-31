import { authConfig } from "./auth-session";
import { idTokenConfig } from "./oidc-id-token";

/**
 * A configured OIDC issuer is not evidence of a verified production release.
 * Require an independent operator-owned switch for both UI and login route.
 * This check performs no network calls and never exposes configuration values.
 */
export function humanAuthReady(): boolean {
  if (process.env.SATNS_HUMAN_AUTH_ENABLED !== "true") return false;
  try {
    const { clientId, origin } = authConfig();
    idTokenConfig(clientId);
    const audience = process.env.OIDC_API_AUDIENCE;
    if (
      !audience ||
      !audience.trim() ||
      (process.env.OIDC_RESOURCE &&
        process.env.OIDC_RESOURCE !== audience)
    )
      return false;
    const declaredOrigin = new URL(process.env.AUTH_PUBLIC_ORIGIN!);
    if (
      declaredOrigin.pathname !== "/" ||
      declaredOrigin.search ||
      declaredOrigin.hash ||
      declaredOrigin.username ||
      declaredOrigin.password
    )
      return false;
    const raw =
      process.env.SATN_API_INTERNAL_URL ??
      process.env.NEXT_PUBLIC_SATN_API_URL;
    if (!raw) return false;
    const api = new URL(raw);
    const developmentLoopback =
      process.env.NODE_ENV !== "production" &&
      api.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(api.hostname);
    return (
      (api.protocol === "https:" || developmentLoopback) &&
      api.origin !== origin &&
      !api.username &&
      !api.password &&
      api.pathname === "/" &&
      !api.search &&
      !api.hash
    );
  } catch {
    return false;
  }
}
