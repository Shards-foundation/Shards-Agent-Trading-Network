import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { registerWalletRoutes } from "./wallets.js";

describe.skipIf(!process.env.DATABASE_URL)("EVM wallet ownership over real PostgreSQL", () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it("binds an EIP-4361 EOA proof only to its OIDC owner and disallows replay, cross-owner use and trading", async () => {
    // Never use this disposable deterministic test key for real assets.
    const wallet = privateKeyToAccount(`0x${"3".repeat(64)}`);
    const otherWallet = privateKeyToAccount(`0x${"4".repeat(64)}`);
    const unique = randomUUID();
    const subjectA = `evm-test-a:${unique}`;
    const subjectB = `evm-test-b:${unique}`;
    const ownerA = await prisma.user.create({ data: { authSubject: subjectA } });
    const ownerB = await prisma.user.create({ data: { authSubject: subjectB } });
    const agentA = await prisma.agent.create({ data: { ownerId: ownerA.id, name: "SIWE Shard" } });
    const agentB = await prisma.agent.create({ data: { ownerId: ownerB.id, name: "Other Shard" } });
    const app = Fastify({ logger: false });
    registerWalletRoutes({
      app, prisma, webOrigin: "https://satns.vercel.app",
      resolveOwnerIdentity: async (authorization) =>
        authorization === "Bearer operator-a" ? { subject: subjectA, actorType: "OIDC_USER" } :
        authorization === "Bearer operator-b" ? { subject: subjectB, actorType: "OIDC_USER" } :
        { error: "INVALID" },
    });
    const post = (path: string, token: string, payload: unknown) => app.inject({
      method: "POST", url: `/v1/owner/wallets/${path}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    try {
      const invalidChain = await post("challenge", "operator-a", {
        chain: "EVM", address: wallet.address, chainId: 999,
      });
      expect(invalidChain.statusCode).toBe(400);
      const challenge = await post("challenge", "operator-a", {
        chain: "EVM", address: wallet.address.toLowerCase(), chainId: 8453,
      });
      expect(challenge.statusCode).toBe(201);
      const first = challenge.json();
      expect(first.message).toContain("Chain ID: 8453");
      expect(first.message).toContain("Nonce: ");
      const validSignature = await wallet.signMessage({ message: first.message });
      const wrongSignature = await otherWallet.signMessage({ message: first.message });
      const tampered = await post("verify", "operator-a", {
        challengeId: first.challengeId, signature: wrongSignature,
      });
      expect(tampered.statusCode).toBe(400);
      const stolen = await post("verify", "operator-b", {
        challengeId: first.challengeId, signature: validSignature,
      });
      expect(stolen.statusCode).toBe(400);
      const verified = await post("verify", "operator-a", {
        challengeId: first.challengeId, signature: validSignature,
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        verified: true, tradingEnabled: false,
        wallet: { chain: "EVM", address: wallet.address, status: "ACTIVE" },
      });
      const walletId: string = verified.json().wallet.id;
      const replay = await post("verify", "operator-a", {
        challengeId: first.challengeId, signature: validSignature,
      });
      expect(replay.statusCode).toBe(400);
      const foreignChallenge = await post("challenge", "operator-b", {
        chain: "EVM", address: wallet.address, chainId: 1,
      });
      expect(foreignChallenge.statusCode).toBe(201);
      const foreignSignature = await wallet.signMessage({ message: foreignChallenge.json().message });
      const foreign = await post("verify", "operator-b", {
        challengeId: foreignChallenge.json().challengeId, signature: foreignSignature,
      });
      expect(foreign.statusCode).toBe(409);
      const otherAgent = await post(`${walletId}/assign`, "operator-a", { agentId: agentB.id });
      expect(otherAgent.statusCode).toBe(404);
      const assigned = await post(`${walletId}/assign`, "operator-a", { agentId: agentA.id });
      expect(assigned.statusCode).toBe(200);
      expect(assigned.json()).toMatchObject({
        executionMode: "PAPER_ONLY", link: { tradeEnabled: false, agentId: agentA.id },
      });
      const revoked = await post(`${walletId}/revoke`, "operator-a", {});
      expect(revoked.statusCode).toBe(200);
      expect((await prisma.agentWalletLink.findUniqueOrThrow({
        where: { walletId_agentId: { walletId, agentId: agentA.id } },
      })).tradeEnabled).toBe(false);
      expect((await prisma.agentWalletLink.findUniqueOrThrow({
        where: { walletId_agentId: { walletId, agentId: agentA.id } },
      })).status).toBe("REVOKED");
    } finally {
      await app.close();
      await prisma.auditEvent.deleteMany({
        where: { actorType: "OIDC_USER", actorId: { in: [subjectA, subjectB] }, action: { startsWith: "wallet." } },
      });
      await prisma.agentWalletLink.deleteMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });
      await prisma.verifiedWallet.deleteMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
      await prisma.walletChallenge.deleteMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
      await prisma.agent.deleteMany({ where: { id: { in: [agentA.id, agentB.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id] } } });
    }
  });
});
