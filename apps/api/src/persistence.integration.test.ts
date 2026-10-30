import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";

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

  it("persists an agent and its simulated journal with provenance", async () => {
    let ownerId: string | undefined;
    let agentId: string | undefined;
    try {
      const owner = await prisma.user.create({
        data: { authSubject: `satn-integration-${randomUUID()}` }
      });
      ownerId = owner.id;

      const agent = await prisma.agent.create({
        data: {
          ownerId,
          name: "SATN integration agent",
          mode: "PAPER"
        }
      });
      agentId = agent.id;

      const journal = await prisma.journalEntry.create({
        data: {
          agentId,
          body: "CI persistence integration fixture.",
          provenance: "SIMULATED",
          publishedAt: new Date()
        }
      });

      const persisted = await prisma.journalEntry.findUnique({
        where: { id: journal.id },
        include: { agent: true }
      });

      expect(persisted).toMatchObject({
        id: journal.id,
        agentId,
        body: "CI persistence integration fixture.",
        provenance: "SIMULATED",
        agent: { name: "SATN integration agent", mode: "PAPER", ownerId }
      });
    } finally {
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
