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
