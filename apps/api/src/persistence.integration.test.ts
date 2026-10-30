import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import { buildServer } from "./index.js";

const integrationEnabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

describe.skipIf(!integrationEnabled)("PostgreSQL and Redis integration", () => {
  const prisma = new PrismaClient();
  const redis = createClient({ url: process.env.REDIS_URL! });
  redis.on("error", () => {
    // Keep test logs free of connection strings.
  });

  beforeAll(async () => {
    await redis.connect();
  });

  afterAll(async () => {
    if (redis.isOpen) await redis.quit();
    await prisma.$disconnect();
  });

  it("persists an agent and exposes only published journal entries through public read APIs", async () => {
    let ownerId: string | undefined;
    let agentId: string | undefined;
    const journalIds: string[] = [];
    const app = buildServer({ prismaClient: prisma, databaseProbe: null, queueProbe: null });
    try {
      const owner = await prisma.user.create({
        data: { authSubject: `satn-integration-${randomUUID()}` }
      });
      ownerId = owner.id;

      const agent = await prisma.agent.create({
        data: {
          ownerId,
          name: "SATN integration agent",
          description: "Temporary CI fixture.",
          mode: "PAPER"
        }
      });
      agentId = agent.id;

      const newer = await prisma.journalEntry.create({
        data: {
          agentId,
          body: "Published journal entry: newer.",
          provenance: "SIMULATED",
          publishedAt: new Date()
        }
      });
      journalIds.push(newer.id);

      const older = await prisma.journalEntry.create({
        data: {
          agentId,
          body: "Published journal entry: older.",
          provenance: "SIMULATED",
          publishedAt: new Date(Date.now() - 5_000)
        }
      });
      journalIds.push(older.id);

      const draft = await prisma.journalEntry.create({
        data: {
          agentId,
          body: "This draft must not appear in public responses.",
          provenance: "SELF_REPORTED",
          publishedAt: null
        }
      });
      journalIds.push(draft.id);

      const profileResponse = await app.inject({ method: "GET", url: `/v1/agents/${agent.id}` });
      expect(profileResponse.statusCode).toBe(200);
      expect(profileResponse.json().agent).toMatchObject({
        id: agent.id,
        name: "SATN integration agent",
        status: "ACTIVE",
        mode: "PAPER"
      });
      expect(profileResponse.body).not.toContain(owner.id);

      const firstPage = await app.inject({ method: "GET", url: "/v1/feed?limit=1" });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().items).toHaveLength(1);
      expect(firstPage.json().items[0]).toMatchObject({
        id: newer.id,
        provenance: "SIMULATED",
        agent: { id: agent.id, name: "SATN integration agent", mode: "PAPER" }
      });
      expect(firstPage.json().nextCursor).toBe(newer.id);
      expect(firstPage.body).not.toContain("This draft must not appear");

      const secondPage = await app.inject({
        method: "GET",
        url: `/v1/feed?limit=1&cursor=${firstPage.json().nextCursor}`
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().items).toHaveLength(1);
      expect(secondPage.json().items[0].id).toBe(older.id);
      expect(secondPage.json().nextCursor).toBeNull();

      const journalResponse = await app.inject({
        method: "GET",
        url: `/v1/agents/${agent.id}/journal?limit=10`
      });
      expect(journalResponse.statusCode).toBe(200);
      expect(journalResponse.json().items.map((entry: { id: string }) => entry.id))
        .toEqual([newer.id, older.id]);

      const performanceResponse = await app.inject({
        method: "GET",
        url: `/v1/agents/${agent.id}/performance?mode=PAPER`
      });
      expect(performanceResponse.statusCode).toBe(200);
      expect(performanceResponse.json().items).toEqual([]);
    } finally {
      await app.close();
      if (agentId) {
        await prisma.journalEntry.deleteMany({ where: { agentId } });
        await prisma.agent.delete({ where: { id: agentId } });
      }
      if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
    }
  });

  it("registers an agent, stores only a credential hash, and publishes audited self-reported journal entries", async () => {
    const previousToken = process.env.AGENT_REGISTRATION_TOKEN;
    const registrationToken = `ci-registration-${randomUUID()}`;
    process.env.AGENT_REGISTRATION_TOKEN = registrationToken;
    const app = buildServer({ prismaClient: prisma, databaseProbe: null, queueProbe: null });
    let agentId: string | undefined;
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { "x-registration-token": registrationToken },
        payload: { name: "Write API integration agent", description: "Created by the integration test." }
      });
      expect(registered.statusCode).toBe(201);
      const registrationBody = registered.json();
      agentId = registrationBody.agent.id;
      const token = registrationBody.credential.token as string;
      expect(token).toMatch(/^satn_agent_/);
      expect(registrationBody.agent.mode).toBe("PAPER");

      const storedCredential = await prisma.agentCredential.findFirst({
        where: { agentId },
        select: { secretHash: true, scopes: true, revokedAt: true }
      });
      expect(storedCredential).not.toBeNull();
      expect(storedCredential?.secretHash).not.toBe(token);
      expect(storedCredential?.scopes).toContain("journal:write");
      expect(storedCredential?.revokedAt).toBeNull();

      const missingAuth = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/journal`,
        payload: { body: "Unauthenticated entry" }
      });
      expect(missingAuth.statusCode).toBe(401);

      const published = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/journal`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: "My strategy notes from the paper session.", publish: true }
      });
      expect(published.statusCode).toBe(201);
      expect(published.json().journal).toMatchObject({
        agentId,
        body: "My strategy notes from the paper session.",
        provenance: "SELF_REPORTED"
      });
      expect(published.json().journal.publishedAt).toBeTruthy();

      const feed = await app.inject({ method: "GET", url: "/v1/feed?limit=50" });
      expect(feed.statusCode).toBe(200);
      expect(feed.body).toContain("My strategy notes from the paper session.");

      const audit = await prisma.auditEvent.findFirst({
        where: { targetType: "JournalEntry", targetId: published.json().journal.id },
        select: { action: true, actorType: true, payloadHash: true, correlationId: true }
      });
      expect(audit).toMatchObject({
        action: "journal.published",
        actorType: "AGENT_CREDENTIAL",
        correlationId: published.headers["x-correlation-id"]
      });
      expect(audit?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await app.close();
      if (agentId) {
        await prisma.journalEntry.deleteMany({ where: { agentId } });
        await prisma.agent.delete({ where: { id: agentId } });
      }
      if (previousToken === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previousToken;
    }
  });

  it("round-trips a namespaced ephemeral value through Redis", async () => {
    const key = `satn:ci:integration:${randomUUID()}`;
    try {
      await redis.set(key, "connected", { EX: 10 });
      await expect(redis.get(key)).resolves.toBe("connected");
    } finally {
      await redis.del(key);
    }
  });
});
