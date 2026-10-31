import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { registerOnboardingRoutes, type OwnerIdentityResult } from "./onboarding.js";

type Reg = { id: string; name: string; description?: string; status: string; claimTokenHash: string;
  exchangeTokenHash: string; expiresAt: Date; ownerId?: string; agentId?: string; claimedAt?: Date; activatedAt?: Date };
function fixture() {
  const regs = new Map<string, Reg>();
  const agents: Array<{ id: string; name: string; mode: string; ownerId: string; scopes: string[]; secretHash: string }> = [];
  const audits: unknown[] = [];
  const users = new Map<string, { id: string; authSubject: string; status: string }>();
  const prismaMock: any = {
    agentRegistration: {
      create: async ({ data }: any) => {
        const record: Reg = { id: randomUUID(), status: "PENDING_CLAIM", ...data };
        regs.set(record.id, record);
        return record;
      },
      findUnique: async ({ where }: any) => [...regs.values()].find(r => r.claimTokenHash === where.claimTokenHash) ?? null,
      findFirst: async ({ where }: any) => [...regs.values()].find(r => r.id === where.id && r.exchangeTokenHash === where.exchangeTokenHash) ?? null,
      updateMany: async ({ where, data }: any) => {
        const record = regs.get(where.id);
        if (!record || record.status !== where.status || (where.expiresAt && record.expiresAt <= where.expiresAt.gt)) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        const record = regs.get(where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data); return record;
      },
    },
    user: { upsert: async ({ where }: any) => {
      if (!users.has(where.authSubject)) users.set(where.authSubject, { id: randomUUID(), authSubject: where.authSubject, status: "ACTIVE" });
      return users.get(where.authSubject);
    } },
    agent: { create: async ({ data }: any) => {
      const agent = { id: randomUUID(), name: data.name, mode: data.mode, ownerId: data.ownerId,
        secretHash: data.credentials.create.secretHash, scopes: data.credentials.create.scopes };
      agents.push(agent); return agent;
    } },
    auditEvent: { create: async ({ data }: any) => { audits.push(data); } },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
  };
  return { prismaMock: prismaMock as PrismaClient, regs, agents, audits };
}
const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe("agent-first public onboarding", () => {
  const servers: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { while (servers.length) await servers.pop()!.close(); });
  function setup(options: { time?: () => Date; owner?: OwnerIdentityResult; disabled?: boolean } = {}) {
    const app = Fastify({ logger: false }); servers.push(app);
    const store = fixture();
    registerOnboardingRoutes({ app, prisma: options.disabled ? null : store.prismaMock,
      resolveOwnerIdentity: async () => options.owner ?? { subject: "https://issuer.test/:person-1", actorType: "OIDC_USER" },
      webOrigin: "https://web.shards.example", ...(options.time ? { now: options.time } : {}) });
    return { app, ...store };
  }
  const register = (app: ReturnType<typeof Fastify>) => app.inject({ method: "POST", url: "/v1/agent-registrations",
    payload: { name: "TestAgent", description: "Verified-paper agent" } });

  it("registers a human owner independently of any agents and rejects bootstrap login", async () => {
    const { app, agents } = setup();
    const created = await app.inject({ method: "POST", url: "/v1/owners/me", headers: { authorization: "Bearer stubbed-valid-oidc" } });
    expect(created.statusCode).toBe(200);
    expect(created.json().owner.status).toBe("ACTIVE");
    expect(agents).toHaveLength(0);
    const blocked = setup({ owner: { subject: "bootstrap:local", actorType: "REGISTRATION_TOKEN" } });
    expect((await blocked.app.inject({ method: "POST", url: "/v1/owners/me" })).statusCode).toBe(401);
  });

  it("creates only a pending registration; never an agent or credential", async () => {
    const { app, agents, regs } = setup();
    const response = await register(app);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("PENDING_CLAIM");
    expect(body.exchangeToken).toMatch(/^satn_exchange_/);
    expect(body.claimUrl).toMatch(/^https:\/\/web\.shards\.example\/claim\/satn_claim_/);
    expect(agents).toHaveLength(0);
    expect(regs.size).toBe(1);
    expect([...regs.values()][0]!.exchangeTokenHash).toBe(h(body.exchangeToken));
    expect(JSON.stringify([...regs.values()][0])).not.toContain(body.exchangeToken);
  });

  it("rejects malformed registration, missing store, wrong exchange secret and pre-claim activation", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "POST", url: "/v1/agent-registrations",
      payload: { name: "x", extra: "unknown" } })).statusCode).toBe(400);
    const data = (await register(app)).json();
    expect((await app.inject({ method: "GET", url: `/v1/agent-registrations/${data.registrationId}/status` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/agent-registrations/${data.registrationId}/status`,
      headers: { authorization: `Bearer ${"s".repeat(60)}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/agent-registrations/${data.registrationId}/activate`,
      headers: { authorization: `Bearer ${data.exchangeToken}` } })).statusCode).toBe(409);
    const unavailable = setup({ disabled: true });
    expect((await register(unavailable.app)).statusCode).toBe(503);
  });

  it("requires real OIDC identity, rejecting bootstrap tokens", async () => {
    const { app } = setup({ owner: { subject: "bootstrap:internal", actorType: "REGISTRATION_TOKEN" } });
    const pending = (await register(app)).json();
    const claimToken = pending.claimUrl.split("/claim/")[1];
    const claim = await app.inject({ method: "POST", url: "/v1/agent-registrations/claim",
      payload: { claimToken }, headers: { "x-registration-token": "anything" } });
    expect(claim.statusCode).toBe(401);
    expect(claim.json().error.code).toBe("OIDC_OWNER_REQUIRED");
  });

  it("claims exactly once and activates with social/journal permissions only", async () => {
    const { app, agents, audits, regs } = setup();
    const pending = (await register(app)).json();
    const claimToken = pending.claimUrl.split("/claim/")[1];
    const preview = await app.inject({ method: "POST", url: "/v1/agent-registrations/preview", payload: { claimToken } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().name).toBe("TestAgent");
    const first = await app.inject({ method: "POST", url: "/v1/agent-registrations/claim",
      payload: { claimToken }, headers: { authorization: "Bearer mocked-valid-owner-jwt" } });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("CLAIMED");
    const second = await app.inject({ method: "POST", url: "/v1/agent-registrations/claim",
      payload: { claimToken }, headers: { authorization: "Bearer mocked-valid-owner-jwt" } });
    expect(second.statusCode).toBe(404);
    const status = await app.inject({ method: "GET", url: `/v1/agent-registrations/${pending.registrationId}/status`,
      headers: { authorization: `Bearer ${pending.exchangeToken}` } });
    expect(status.json().status).toBe("CLAIMED");
    const activated = await app.inject({ method: "POST", url: `/v1/agent-registrations/${pending.registrationId}/activate`,
      headers: { authorization: `Bearer ${pending.exchangeToken}` } });
    expect(activated.statusCode).toBe(201);
    expect(activated.json().credential.scopes).toEqual(["journal:write", "social:write"]);
    expect(activated.json().credential.scopes).not.toContain("trade-intent:write");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.secretHash).toBe(h(activated.json().credential.token));
    expect([...regs.values()][0]!.status).toBe("ACTIVATED");
    expect(audits).toHaveLength(2);
    const retry = await app.inject({ method: "POST", url: `/v1/agent-registrations/${pending.registrationId}/activate`,
      headers: { authorization: `Bearer ${pending.exchangeToken}` } });
    expect(retry.statusCode).toBe(409);
    expect(agents).toHaveLength(1);
  });

  it("expires unused registrations and rejects late claims", async () => {
    let time = Date.UTC(2026, 9, 31);
    const { app, agents } = setup({ time: () => new Date(time) });
    const pending = (await register(app)).json();
    time += 25 * 3600 * 1000;
    const status = await app.inject({ method: "GET", url: `/v1/agent-registrations/${pending.registrationId}/status`,
      headers: { authorization: `Bearer ${pending.exchangeToken}` } });
    expect(status.json().status).toBe("EXPIRED");
    const claim = await app.inject({ method: "POST", url: "/v1/agent-registrations/claim",
      payload: { claimToken: pending.claimUrl.split("/claim/")[1] }, headers: { authorization: "Bearer valid" } });
    expect(claim.statusCode).toBe(404);
    expect(agents).toHaveLength(0);
  });
});
