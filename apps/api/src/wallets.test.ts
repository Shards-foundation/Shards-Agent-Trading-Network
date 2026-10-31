import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerWalletRoutes } from "./wallets.js";

describe("wallet control plane fails closed", () => {
  it("requires OIDC human identity before public wallet operations", async () => {
    const app = Fastify();
    registerWalletRoutes({
      app, prisma: null, resolveOwnerIdentity: async () => ({ error: "INVALID" }),
      webOrigin: "https://satns.vercel.app",
    });
    const response = await app.inject({
      method: "POST", url: "/v1/owner/wallets/challenge",
      payload: { chain: "SOLANA", address: "11111111111111111111111111111111" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("OIDC_OWNER_REQUIRED");
    await app.close();
  });
  it("rejects wallet registration without PostgreSQL", async () => {
    const app = Fastify();
    registerWalletRoutes({
      app, prisma: null,
      resolveOwnerIdentity: async () => ({ subject: "issuer:subject", actorType: "OIDC_USER" }),
      webOrigin: "https://satns.vercel.app",
    });
    const response = await app.inject({
      method: "POST", url: "/v1/owner/wallets/challenge",
      payload: { chain: "SOLANA", address: "11111111111111111111111111111111" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DATA_STORE_UNAVAILABLE");
    await app.close();
  });
});
