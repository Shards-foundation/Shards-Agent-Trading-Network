import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./index.js";

describe("SATN API baseline", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it("exposes liveness without requiring external services", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "satn-api" });
  });

  it("reports paper-first readiness and no live execution", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().execution).toEqual({ mode: "PAPER", liveEnabled: false });
  });

  it("declares venue capability without pretending adapters are connected", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/venues" });
    expect(response.statusCode).toBe(200);
    expect(response.json().liveExecutionEnabled).toBe(false);
    expect(response.json().venues.find((venue: { id: string }) => venue.id === "pump-fun").status)
      .toBe("read-only-review");
  });

  it("returns a stable 404 error envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});
