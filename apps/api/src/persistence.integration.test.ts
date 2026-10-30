import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
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

  it("enforces scoped, idempotent agent follows and exposes paginated follower lists", async () => {
    const owner = await prisma.user.create({ data: { authSubject: `satn-follow-${randomUUID()}` } });
    const sourceToken = `satn_agent_follow_source_${randomUUID()}`;
    const source = await prisma.agent.create({
      data: {
        ownerId: owner.id,
        name: "Follow source agent",
        credentials: {
          create: {
            secretHash: createHash("sha256").update(sourceToken).digest("hex"),
            scopes: ["social:write"]
          }
        }
      }
    });
    const target = await prisma.agent.create({
      data: { ownerId: owner.id, name: "Follow target agent" }
    });
    const relationTargetId = `${source.id}:${target.id}`;
    const app = buildServer({ prismaClient: prisma, databaseProbe: null, queueProbe: null });
    try {
      const missingAuth = await app.inject({
        method: "POST", url: `/v1/agents/${source.id}/follows/${target.id}`
      });
      expect(missingAuth.statusCode).toBe(401);

      const selfFollow = await app.inject({
        method: "POST",
        url: `/v1/agents/${source.id}/follows/${source.id}`,
        headers: { authorization: `Bearer ${sourceToken}` }
      });
      expect(selfFollow.statusCode).toBe(422);
      expect(selfFollow.json().error.code).toBe("SELF_FOLLOW_NOT_ALLOWED");

      const followed = await app.inject({
        method: "POST",
        url: `/v1/agents/${source.id}/follows/${target.id}`,
        headers: { authorization: `Bearer ${sourceToken}`, "x-correlation-id": "agent-follow-integration" }
      });
      expect(followed.statusCode).toBe(201);
      expect(followed.json()).toEqual({ following: true, changed: true });

      const replay = await app.inject({
        method: "POST",
        url: `/v1/agents/${source.id}/follows/${target.id}`,
        headers: { authorization: `Bearer ${sourceToken}` }
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ following: true, changed: false });

      const following = await app.inject({ method: "GET", url: `/v1/agents/${source.id}/following?limit=10` });
      expect(following.statusCode).toBe(200);
      expect(following.json().items).toEqual([expect.objectContaining({
        agent: expect.objectContaining({ id: target.id, name: target.name })
      })]);
      expect(following.json().nextCursor).toBeNull();

      const followers = await app.inject({ method: "GET", url: `/v1/agents/${target.id}/followers?limit=10` });
      expect(followers.statusCode).toBe(200);
      expect(followers.json().items).toEqual([expect.objectContaining({
        agent: expect.objectContaining({ id: source.id, name: source.name })
      })]);

      const targetProfile = await app.inject({ method: "GET", url: `/v1/agents/${target.id}` });
      expect(targetProfile.statusCode).toBe(200);
      expect(targetProfile.json().agent).toMatchObject({ followerCount: 1, followingCount: 0 });
      const directory = await app.inject({ method: "GET", url: "/v1/agents?limit=50" });
      const sourceListing = directory.json().items.find((item: { id: string }) => item.id === source.id);
      expect(sourceListing).toMatchObject({ followerCount: 0, followingCount: 1 });

      const unfollowed = await app.inject({
        method: "DELETE",
        url: `/v1/agents/${source.id}/follows/${target.id}`,
        headers: { authorization: `Bearer ${sourceToken}` }
      });
      expect(unfollowed.statusCode).toBe(200);
      expect(unfollowed.json()).toEqual({ following: false, changed: true });

      const repeatedUnfollow = await app.inject({
        method: "DELETE",
        url: `/v1/agents/${source.id}/follows/${target.id}`,
        headers: { authorization: `Bearer ${sourceToken}` }
      });
      expect(repeatedUnfollow.json()).toEqual({ following: false, changed: false });
      expect(await prisma.auditEvent.count({
        where: { targetType: "AgentFollow", targetId: relationTargetId, action: { in: ["agent.followed", "agent.unfollowed"] } }
      })).toBe(2);
    } finally {
      await app.close();
      await prisma.auditEvent.deleteMany({ where: { targetType: "AgentFollow", targetId: relationTargetId } });
      await prisma.agent.deleteMany({ where: { id: { in: [source.id, target.id] } } });
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });

  it("creates agent posts and replies with scoped credentials, public feed visibility and audit evidence", async () => {
    const owner = await prisma.user.create({ data: { authSubject: `satn-post-${randomUUID()}` } });
    const token = `satn_agent_post_${randomUUID()}`;
    const agent = await prisma.agent.create({
      data: {
        ownerId: owner.id,
        name: "Posting agent",
        credentials: {
          create: {
            secretHash: createHash("sha256").update(token).digest("hex"),
            scopes: ["social:write"]
          }
        }
      }
    });
    const replyOwner = await prisma.user.create({ data: { authSubject: `satn-replier-${randomUUID()}` } });
    const replyToken = `satn_agent_reply_${randomUUID()}`;
    const replier = await prisma.agent.create({
      data: {
        ownerId: replyOwner.id,
        name: "Reply agent",
        credentials: {
          create: {
            secretHash: createHash("sha256").update(replyToken).digest("hex"),
            scopes: ["social:write"]
          }
        }
      }
    });
    const app = buildServer({ prismaClient: prisma, databaseProbe: null, queueProbe: null });
    let postId: string | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: `/v1/agents/${agent.id}/posts`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: "An agent-native public update." }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().post).toMatchObject({
        agentId: agent.id,
        body: "An agent-native public update.",
        provenance: "SELF_REPORTED",
        parentId: null
      });
      postId = created.json().post.id;

      const reply = await app.inject({
        method: "POST",
        url: `/v1/agents/${replier.id}/posts/${postId}/replies`,
        headers: { authorization: `Bearer ${replyToken}` },
        payload: { body: "A reply from another agent." }
      });
      expect(reply.statusCode).toBe(201);
      expect(reply.json().post).toMatchObject({ agentId: replier.id, parentId: postId, provenance: "SELF_REPORTED" });

      const feed = await app.inject({ method: "GET", url: "/v1/posts?limit=20" });
      expect(feed.statusCode).toBe(200);
      expect(feed.json().items).toContainEqual(expect.objectContaining({
        id: postId, body: "An agent-native public update.", replyCount: 1,
        agent: expect.objectContaining({ id: agent.id, name: agent.name })
      }));
      expect(feed.json().items.some((item: { id: string }) => item.id === reply.json().post.id)).toBe(false);

      const replies = await app.inject({ method: "GET", url: `/v1/posts/${postId}/replies?limit=20` });
      expect(replies.statusCode).toBe(200);
      expect(replies.json().items).toContainEqual(expect.objectContaining({
        id: reply.json().post.id, body: "A reply from another agent.",
        agent: expect.objectContaining({ id: replier.id })
      }));

      const audit = await prisma.auditEvent.findMany({
        where: { targetType: "AgentPost", targetId: { in: [postId, reply.json().post.id] } },
        select: { action: true, actorType: true, payloadHash: true }
      });
      expect(audit.map((entry) => entry.action).sort()).toEqual(["social.post_created", "social.reply_created"]);
      expect(audit.every((entry) => entry.actorType === "AGENT_CREDENTIAL" && /^[a-f0-9]{64}$/.test(entry.payloadHash))).toBe(true);
    } finally {
      await app.close();
      if (postId) await prisma.agentPost.deleteMany({ where: { id: postId } });
      await prisma.agentPost.deleteMany({ where: { agentId: { in: [agent.id, replier.id] } } });
      await prisma.agent.deleteMany({ where: { id: { in: [agent.id, replier.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, replyOwner.id] } } });
    }
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
        const intents = await prisma.tradeIntent.findMany({ where: { agentId }, select: { id: true } });
        const intentIds = intents.map((intent) => intent.id);
        const orders = await prisma.venueOrder.findMany({ where: { intentId: { in: intentIds } }, select: { id: true } });
        const orderIds = orders.map((order) => order.id);
        await prisma.fill.deleteMany({ where: { venueOrderId: { in: orderIds } } });
        await prisma.venueOrder.deleteMany({ where: { intentId: { in: intentIds } } });
        await prisma.riskDecision.deleteMany({ where: { intentId: { in: intentIds } } });
        await prisma.tradeIntent.deleteMany({ where: { agentId } });
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
    const app = buildServer({
      prismaClient: prisma,
      databaseProbe: null,
      queueProbe: null,
      marketDataProvider: {
        async getMarketSnapshot(instrumentId) {
          const observedAt = new Date().toISOString();
          return {
            venue: "hyperliquid",
            instrumentId,
            observedAt,
            receivedAt: observedAt,
            source: "integration-test",
            bid: "99.5",
            ask: "100",
            dataQuality: "LIVE"
          };
        }
      }
    });
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
      const createdAgentId = registrationBody.agent.id as string;
      agentId = createdAgentId;
      const token = registrationBody.credential.token as string;
      expect(token).toMatch(/^satn_agent_/);
      expect(registrationBody.agent.mode).toBe("PAPER");

      const directory = await app.inject({ method: "GET", url: "/v1/agents?limit=10" });
      expect(directory.statusCode).toBe(200);
      expect(directory.json().items).toContainEqual(expect.objectContaining({
        id: createdAgentId,
        name: "Write API integration agent",
        mode: "PAPER",
        journalCount: 0,
        tradeIntentCount: 0,
        strategyVersionCount: 0
      }));
      expect(directory.body).not.toContain("ownerId");

      const storedCredential = await prisma.agentCredential.findFirst({
        where: { agentId: createdAgentId },
        select: { secretHash: true, scopes: true, revokedAt: true }
      });
      expect(storedCredential).not.toBeNull();
      expect(storedCredential?.secretHash).not.toBe(token);
      expect(storedCredential?.scopes).toContain("journal:write");
      expect(storedCredential?.revokedAt).toBeNull();

      const missingAuth = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/journal`,
        payload: { body: "Unauthenticated entry" }
      });
      expect(missingAuth.statusCode).toBe(401);

      const published = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/journal`,
        headers: { authorization: `Bearer ${token}`, "x-correlation-id": "satn-journal-test" },
        payload: { body: "My strategy notes from the paper session.", publish: true }
      });
      expect(published.statusCode).toBe(201);
      expect(published.json().journal).toMatchObject({
        agentId,
        body: "My strategy notes from the paper session.",
        provenance: "SELF_REPORTED"
      });
      expect(published.json().journal.publishedAt).toBeTruthy();

      const directoryAfterPublish = await app.inject({ method: "GET", url: "/v1/agents?limit=10" });
      const listedAgent = directoryAfterPublish.json().items.find((item: { id: string }) => item.id === createdAgentId);
      expect(listedAgent).toMatchObject({ journalCount: 1 });

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
        correlationId: "satn-journal-test"
      });
      expect(audit?.payloadHash).toMatch(/^[a-f0-9]{64}$/);

      expect(storedCredential?.scopes).toContain("trade-intent:write");
      expect(storedCredential?.scopes).toContain("social:write");
      const intentPayload = {
        venue: "hyperliquid",
        instrument: "BTC",
        side: "BUY",
        quantity: "1",
        orderType: "LIMIT",
        limitPrice: "100",
        mode: "PAPER"
      };
      const idempotencyKey = `paper-trade-${randomUUID()}`;
      const trade = await app.inject({
        method: "POST",
        url: "/v1/trade-intents",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
        payload: intentPayload
      });
      expect(trade.statusCode).toBe(201);
      expect(trade.json()).toMatchObject({
        replayed: false,
        intent: { agentId: createdAgentId, mode: "PAPER", status: "FILLED" },
        riskDecision: { outcome: "APPROVED", reasonCodes: [] },
        venueOrder: { state: "FILLED", fills: [{ price: "100", quantity: "1", fee: "0.1", feeAsset: "USD" }] },
        simulation: { status: "FILLED", evidenceLabel: "SIMULATED", fillPrice: "100", fee: "0.1" }
      });

      const performance = await app.inject({
        method: "GET",
        url: `/v1/agents/${createdAgentId}/performance?mode=PAPER`
      });
      expect(performance.statusCode).toBe(200);
      expect(performance.json().summary).toMatchObject({
        methodologyVersion: "paper-average-cost-v1",
        provenance: "SIMULATED",
        fillCount: 1,
        instrumentCount: 1,
        openPositionCount: 1,
        realizedGrossPnl: "0",
        feesPaidUsd: "0.1",
        netRealizedPnlLessAllUsdFees: "-0.1",
        qualityFlags: ["SIMULATED_EXECUTION_ONLY", "UNREALISED_PNL_EXCLUDED"]
      });
      expect(performance.json().summary.instruments[0]).toMatchObject({
        instrument: "BTC",
        positionQuantity: "1",
        averageEntryPrice: "100"
      });

      const replay = await app.inject({
        method: "POST",
        url: "/v1/trade-intents",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
        payload: intentPayload
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().replayed).toBe(true);
      expect(await prisma.tradeIntent.count({ where: { agentId: createdAgentId, idempotencyKey } })).toBe(1);

      const conflictingReplay = await app.inject({
        method: "POST",
        url: "/v1/trade-intents",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
        payload: { ...intentPayload, quantity: "2" }
      });
      expect(conflictingReplay.statusCode).toBe(409);
      expect(conflictingReplay.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");


      const rejected = await app.inject({
        method: "POST",
        url: "/v1/trade-intents",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": `over-limit-${randomUUID()}` },
        payload: { ...intentPayload, quantity: "20" }
      });
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.code).toBe("RISK_REJECTED");
      expect(rejected.json().error.reasons).toContain("ORDER_NOTIONAL_EXCEEDED");
      expect(rejected.json().intent.status).toBe("RISK_REJECTED");

      const publicTradePage = await app.inject({ method: "GET", url: "/v1/trades?limit=1" });
      expect(publicTradePage.statusCode).toBe(200);
      expect(publicTradePage.json().items).toHaveLength(1);
      expect(publicTradePage.json().nextCursor).toBeTruthy();
      expect(publicTradePage.body).not.toContain(idempotencyKey);
      const publicTradeSecondPage = await app.inject({
        method: "GET",
        url: `/v1/trades?limit=1&cursor=${publicTradePage.json().nextCursor}`
      });
      expect(publicTradeSecondPage.statusCode).toBe(200);
      expect(publicTradeSecondPage.json().items).toHaveLength(1);
      const publicTrades = [...publicTradePage.json().items, ...publicTradeSecondPage.json().items];
      expect(new Set(publicTrades.map((entry) => entry.id))).toEqual(new Set([trade.json().intent.id, rejected.json().intent.id]));
      expect(publicTrades.find((entry) => entry.id === trade.json().intent.id)).toMatchObject({
        status: "FILLED",
        provenance: "SIMULATED",
        venueOrder: { state: "FILLED", fills: [{ price: "100", fee: "0.1", feeAsset: "USD" }] }
      });
      expect(publicTrades.find((entry) => entry.id === rejected.json().intent.id)).toMatchObject({
        status: "RISK_REJECTED",
        provenance: "NOT_EXECUTED",
        venueOrder: null
      });

      // Seed a prior-day ETH long. Two concurrent closes would each pass a
      // stale pre-check, but the transaction lock must let only one cross the
      // daily loss threshold.
      const seedId = randomUUID();
      const priorDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const seedIntent = await prisma.tradeIntent.create({
        data: {
          agentId: createdAgentId,
          venue: "hyperliquid",
          instrument: "ETH",
          side: "BUY",
          orderType: "LIMIT",
          quantity: "2",
          limitPrice: "1000",
          mode: "PAPER",
          idempotencyKey: `loss-seed-${seedId}`,
          payloadHash: "a".repeat(64),
          status: "FILLED"
        }
      });
      await prisma.venueOrder.create({
        data: {
          intentId: seedIntent.id,
          venue: "hyperliquid",
          clientOrderId: `loss-seed-client-${seedId}`,
          venueOrderId: `loss-seed-order-${seedId}`,
          state: "FILLED",
          submittedAt: priorDay,
          fills: {
            create: {
              fillRef: `loss-seed-fill-${seedId}`,
              price: "1000",
              quantity: "2",
              fee: "0",
              feeAsset: "USD",
              filledAt: priorDay
            }
          }
        }
      });
      const concurrentCloses = await Promise.all(["close-a", "close-b"].map((suffix) =>
        app.inject({
          method: "POST",
          url: "/v1/trade-intents",
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": `loss-${suffix}-${seedId}`
          },
          payload: {
            venue: "hyperliquid",
            instrument: "ETH",
            side: "SELL",
            quantity: "1",
            orderType: "LIMIT",
            limitPrice: "1",
            mode: "PAPER"
          }
        })
      ));
      expect(concurrentCloses.filter((response) => response.statusCode === 201)).toHaveLength(1);
      expect(concurrentCloses.filter((response) => response.statusCode === 422)).toHaveLength(1);
      const lossRejected = concurrentCloses.find((response) => response.statusCode === 422);
      expect(lossRejected?.json().error.reasons).toContain("DAILY_LOSS_LIMIT_REACHED");
      const ethFills = await prisma.fill.findMany({
        where: { venueOrder: { is: { intent: { is: { agentId: createdAgentId, instrument: "ETH" } } } } },
        select: { id: true }
      });
      expect(ethFills).toHaveLength(2);
      const pause = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/pause`,
        headers: { "x-registration-token": registrationToken }
      });
      expect(pause.statusCode).toBe(200);
      expect(pause.json()).toMatchObject({ agentId: createdAgentId, status: "PAUSED", changed: true });
      const pausedJournalWrite = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/journal`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: "This must be rejected while paused." }
      });
      expect(pausedJournalWrite.statusCode).toBe(401);
      const hiddenFeed = await app.inject({ method: "GET", url: "/v1/feed?limit=50" });
      expect(hiddenFeed.body).not.toContain("My strategy notes from the paper session.");
      const pausedDirectory = await app.inject({ method: "GET", url: "/v1/agents?limit=50" });
      expect(pausedDirectory.body).not.toContain(createdAgentId);

      const pausedProfile = await app.inject({ method: "GET", url: `/v1/agents/${createdAgentId}` });
      expect(pausedProfile.statusCode).toBe(404);
      const pausedJournal = await app.inject({ method: "GET", url: `/v1/agents/${createdAgentId}/journal` });
      expect(pausedJournal.statusCode).toBe(404);

      const resume = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/resume`,
        headers: { "x-registration-token": registrationToken }
      });
      expect(resume.statusCode).toBe(200);
      expect(resume.json()).toMatchObject({ agentId: createdAgentId, status: "ACTIVE", changed: true });

      const rotated = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/credentials/rotate`,
        headers: { "x-registration-token": registrationToken }
      });
      expect(rotated.statusCode).toBe(201);
      const replacementToken = rotated.json().credential.token as string;
      expect(replacementToken).toMatch(/^satn_agent_/);
      expect(replacementToken).not.toBe(token);
      const rotatedCredential = await prisma.agentCredential.findUnique({
        where: { secretHash: createHash("sha256").update(replacementToken).digest("hex") },
        select: { scopes: true }
      });
      expect(rotatedCredential?.scopes).toContain("social:write");

      const oldTokenWrite = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/journal`,
        headers: { authorization: `Bearer ${token}` },
        payload: { body: "Old credential must not work." }
      });
      expect(oldTokenWrite.statusCode).toBe(401);

      const newTokenWrite = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/journal`,
        headers: { authorization: `Bearer ${replacementToken}` },
        payload: { body: "Replacement credential works.", publish: false }
      });
      expect(newTokenWrite.statusCode).toBe(201);

      const revoke = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/credentials/revoke`,
        headers: { "x-registration-token": registrationToken }
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().revokedCount).toBe(1);
      const revokedTokenWrite = await app.inject({
        method: "POST",
        url: `/v1/agents/${createdAgentId}/journal`,
        headers: { authorization: `Bearer ${replacementToken}` },
        payload: { body: "Revoked credential must not work." }
      });
      expect(revokedTokenWrite.statusCode).toBe(401);

      const lifecycleAudit = await prisma.auditEvent.findMany({
        where: { targetId: createdAgentId, action: { in: ["agent.paused", "agent.resumed", "agent.credentials_rotated", "agent.credentials_revoked"] } },
        select: { action: true }
      });
      expect(lifecycleAudit.map((event) => event.action).sort()).toEqual([
        "agent.credentials_revoked",
        "agent.credentials_rotated",
        "agent.paused",
        "agent.resumed"
      ]);
    } finally {
      await app.close();
      if (agentId) {
        const intents = await prisma.tradeIntent.findMany({ where: { agentId }, select: { id: true } });
        const intentIds = intents.map((intent) => intent.id);
        const orders = await prisma.venueOrder.findMany({ where: { intentId: { in: intentIds } }, select: { id: true } });
        const orderIds = orders.map((order) => order.id);
        await prisma.fill.deleteMany({ where: { venueOrderId: { in: orderIds } } });
        await prisma.venueOrder.deleteMany({ where: { intentId: { in: intentIds } } });
        await prisma.riskDecision.deleteMany({ where: { intentId: { in: intentIds } } });
        await prisma.tradeIntent.deleteMany({ where: { agentId } });
        await prisma.journalEntry.deleteMany({ where: { agentId } });
        await prisma.agent.delete({ where: { id: agentId } });
      }
      if (previousToken === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previousToken;
    }
  });

  it("registers OIDC-owned agents and enforces owner isolation on lifecycle controls", async () => {
    const previous = {
      issuer: process.env.OIDC_ISSUER,
      audience: process.env.OIDC_AUDIENCE,
      jwksUrl: process.env.OIDC_JWKS_URL,
      registrationToken: process.env.AGENT_REGISTRATION_TOKEN
    };
    const issuer = "https://satn-oidc-integration.example/";
    const audience = "satn-api";
    const subject = `oidc-user-${randomUUID()}`;
    const authSubject = `${issuer}:${subject}`;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "satn-oidc-ci-key", alg: "RS256", use: "sig" };
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    let agentId: string | undefined;
    let ownerId: string | undefined;

    const createToken = (tokenSubject: string) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "satn-oidc-ci-key" })).toString("base64url");
      const encodedPayload = Buffer.from(JSON.stringify({
        iss: issuer,
        aud: audience,
        sub: tokenSubject,
        iat: nowSeconds,
        exp: nowSeconds + 600
      })).toString("base64url");
      const signedContent = `${encodedHeader}.${encodedPayload}`;
      return `${signedContent}.${sign("RSA-SHA256", Buffer.from(signedContent), privateKey).toString("base64url")}`;
    };

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OIDC test JWKS server failed to bind.");
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_AUDIENCE = audience;
    process.env.OIDC_JWKS_URL = `http://127.0.0.1:${address.port}/jwks`;
    // OIDC must take precedence even when the legacy bootstrap secret is present.
    process.env.AGENT_REGISTRATION_TOKEN = "must-not-bypass-oidc";
    const token = createToken(subject);
    const app = buildServer({ prismaClient: prisma, databaseProbe: null, queueProbe: null });
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "OIDC integration agent", description: "Owner isolation test." }
      });
      expect(registered.statusCode).toBe(201);
      agentId = registered.json().agent.id as string;
      const owner = await prisma.user.findUnique({ where: { authSubject }, select: { id: true } });
      expect(owner).not.toBeNull();
      ownerId = owner?.id;

      const anotherOwnerToken = createToken(`other-user-${randomUUID()}`);
      const forbiddenPause = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/pause`,
        headers: { authorization: `Bearer ${anotherOwnerToken}` }
      });
      expect(forbiddenPause.statusCode).toBe(404);
      expect(forbiddenPause.json().error.code).toBe("AGENT_NOT_FOUND");

      const ownerPause = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/pause`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(ownerPause.statusCode).toBe(200);
      expect(ownerPause.json()).toMatchObject({ agentId, status: "PAUSED", changed: true });
    } finally {
      await app.close();
      if (agentId) {
        await prisma.agent.delete({ where: { id: agentId } });
      }
      if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous.issuer === undefined) delete process.env.OIDC_ISSUER;
      else process.env.OIDC_ISSUER = previous.issuer;
      if (previous.audience === undefined) delete process.env.OIDC_AUDIENCE;
      else process.env.OIDC_AUDIENCE = previous.audience;
      if (previous.jwksUrl === undefined) delete process.env.OIDC_JWKS_URL;
      else process.env.OIDC_JWKS_URL = previous.jwksUrl;
      if (previous.registrationToken === undefined) delete process.env.AGENT_REGISTRATION_TOKEN;
      else process.env.AGENT_REGISTRATION_TOKEN = previous.registrationToken;
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
