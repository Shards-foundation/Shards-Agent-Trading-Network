import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/onboarding/config/route";
import JoinPage from "../app/join/page";
import AgentOnboardingLauncher from "../app/AgentOnboardingLauncher";

beforeEach(() => {
  vi.stubEnv("SATNS_HUMAN_AUTH_ENABLED", "");
  vi.stubEnv("NEXT_PUBLIC_SATN_API_URL", "");
  vi.stubEnv("SATN_API_INTERNAL_URL", "https://private-backend.example.test");
});
afterEach(() => vi.unstubAllEnvs());

function configure() {
  const values = {
    SATNS_HUMAN_AUTH_ENABLED: "true",
    OIDC_CLIENT_ID: "onboarding-test-client",
    OIDC_API_AUDIENCE: "satn-api",
    OIDC_AUTHORIZATION_ENDPOINT: "https://id.example.test/authorize",
    OIDC_TOKEN_ENDPOINT: "https://id.example.test/token",
    OIDC_ISSUER: "https://id.example.test/",
    OIDC_JWKS_URL: "https://id.example.test/jwks",
    OIDC_ID_TOKEN_ALGORITHM: "RS256",
    AUTH_PUBLIC_ORIGIN: "https://satns.vercel.app",
    SATN_SESSION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    NEXT_PUBLIC_SATN_API_URL: "https://public-api.example.test/",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

describe("public agent onboarding discovery", () => {
  it("fails closed without exposing the private backend or secrets", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.registration_configured).toBe(false);
    expect(json.api_origin).toBeNull();
    expect(json.readiness).toBe("not_checked");
    expect(JSON.stringify(json)).not.toContain("private-backend");
  });

  it("advertises the public API only after the human claim gate is configured", async () => {
    configure();
    const json = await (await GET()).json();
    expect(json.registration_configured).toBe(true);
    expect(json.api_origin).toBe("https://public-api.example.test");
    expect(json.initial_scopes).toEqual(["journal:write", "social:write"]);
    expect(json.live_trading_enabled).toBe(false);
    expect(json.readiness).toBe("not_checked");
    expect(JSON.stringify(json)).not.toContain(process.env.SATN_SESSION_KEY);
  });

  it.each([
    "",
    "not a URL",
    "http://public-api.example.test",
    "https://user:secret@public-api.example.test",
    "https://public-api.example.test/v1",
    "https://public-api.example.test/?token=secret",
    "https://public-api.example.test/#secret",
    "https://satns.vercel.app",
  ])("does not advertise an invalid public origin: %s", async (value) => {
    configure();
    vi.stubEnv("NEXT_PUBLIC_SATN_API_URL", value);
    const json = await (await GET()).json();
    expect(json.registration_configured).toBe(false);
    expect(json.api_origin).toBeNull();
  });

  it("keeps agent registration unavailable while the owner release switch is off", async () => {
    configure();
    vi.stubEnv("SATNS_HUMAN_AUTH_ENABLED", "false");
    expect((await (await GET()).json()).registration_configured).toBe(false);
  });
});

describe("onboarding entry points", () => {
  it("offers a selectable prompt and real guide while registration is unavailable", () => {
    const html = renderToStaticMarkup(JoinPage());
    expect(html).toContain("Registration not yet open");
    expect(html).toContain('href="/get-started.md"');
    expect(html).toContain("https://satns.vercel.app/get-started.md");
    expect(html).toContain('id="agent-setup"');
    expect(html).toContain("Copy onboarding prompt");
    expect(html).not.toContain('href="/api/auth/login');
    expect(html).not.toContain("private-backend");
  });

  it("does not describe configuration as a successful live connection", () => {
    configure();
    const html = renderToStaticMarkup(JoinPage());
    expect(html).toContain("Setup configured");
    expect(html).toContain("verify API readiness");
    expect(html).toContain('href="/api/auth/login?intent=signup"');
  });

  it("provides an accessible homepage handoff and dismiss action", () => {
    const html = renderToStaticMarkup(<AgentOnboardingLauncher />);
    expect(html).toContain('href="/join#agent-setup"');
    expect(html).toContain("Onboard Your Agent");
    expect(html).toContain('aria-label="Dismiss agent onboarding"');
    expect(html).toContain('aria-label="Copy onboarding prompt"');
    // Server-rendered copy must wait for its handler; the link works without JS.
    expect(html).toContain('disabled=""');
  });

  it("publishes discoverable references to one canonical guide", () => {
    const manifest = JSON.parse(readFileSync("public/skill.json", "utf8"));
    expect(manifest.get_started).toBe("/get-started.md");
    expect(manifest.configuration).toBe("/api/onboarding/config");
    expect(manifest.api_status).toBe("not_verified");
    for (const path of [
      manifest.get_started,
      manifest.rules,
      manifest.heartbeat,
    ]) {
      expect(readFileSync(`public${path}`, "utf8").length).toBeGreaterThan(100);
    }
    expect(readFileSync("public/skill.md", "utf8")).toContain("get-started.md");
  });
});
