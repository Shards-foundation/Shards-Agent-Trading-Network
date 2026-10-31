import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { decodeSolanaAddress, newWalletChallenge, verifySolanaWalletProof } from "./wallet-crypto.js";
import type { OwnerIdentityResult } from "./onboarding.js";

const uuid = z.string().uuid();
const challengeInput = z.object({ chain: z.literal("SOLANA"), address: z.string().min(32).max(44) }).strict();
const proofInput = z.object({ challengeId: uuid, signature: z.string().min(80).max(100) }).strict();
const assignInput = z.object({ agentId: uuid }).strict();
const fail = (code: string, correlationId: string) => ({ error: { code, correlationId, retryable: false } });
const ttlMs = 5 * 60_000;

export function registerWalletRoutes({
  app, prisma, resolveOwnerIdentity, webOrigin, now = () => new Date(),
}: {
  app: FastifyInstance;
  prisma: PrismaClient | null;
  resolveOwnerIdentity: (authorization: unknown, registrationToken: unknown) => Promise<OwnerIdentityResult>;
  webOrigin: string;
  now?: () => Date;
}): void {
  async function owner(request: FastifyRequest, reply: any) {
    const auth = await resolveOwnerIdentity(request.headers.authorization, undefined);
    if ("error" in auth || auth.actorType !== "OIDC_USER") {
      reply.code(401).send(fail("OIDC_OWNER_REQUIRED", request.id));
      return null;
    }
    if (!prisma) {
      reply.code(503).send(fail("DATA_STORE_UNAVAILABLE", request.id));
      return null;
    }
    return auth.subject;
  }

  app.get("/v1/owner/wallets", async (request, reply) => {
    const subject = await owner(request, reply);
    if (!subject) return;
    try {
      const identity = await prisma!.user.findUnique({
        where: { authSubject: subject },
        select: { id: true, status: true },
      });
      if (!identity || identity.status !== "ACTIVE") return { wallets: [], agents: [] };
      const [wallets, agents] = await Promise.all([
        prisma!.verifiedWallet.findMany({
          where: { ownerId: identity.id },
          select: {
            id: true, chain: true, address: true, status: true, verifiedAt: true,
            agentLinks: { select: { agentId: true, status: true, tradeEnabled: true } },
          },
          orderBy: { createdAt: "desc" }, take: 50,
        }),
        prisma!.agent.findMany({
          where: { ownerId: identity.id, status: "ACTIVE" },
          select: { id: true, name: true, mode: true },
          orderBy: { createdAt: "desc" }, take: 100,
        }),
      ]);
      return { wallets, agents, executionMode: "PAPER_ONLY" };
    } catch (err) {
      request.log.error({ err }, "wallet discovery failed");
      return reply.code(503).send(fail("WALLET_SERVICE_UNAVAILABLE", request.id));
    }
  });

  app.post("/v1/owner/wallets/challenge", async (request, reply) => {
    const subject = await owner(request, reply);
    if (!subject) return;
    const input = challengeInput.safeParse(request.body);
    if (!input.success || !decodeSolanaAddress(input.data.address))
      return reply.code(400).send(fail("INVALID_SOLANA_ADDRESS", request.id));
    try {
      const identity = await prisma!.user.upsert({
        where: { authSubject: subject },
        create: { authSubject: subject },
        update: {},
        select: { id: true, status: true },
      });
      if (identity.status !== "ACTIVE") return reply.code(403).send(fail("OWNER_DISABLED", request.id));
      const current = now();
      const recent = await prisma!.walletChallenge.count({
        where: { ownerId: identity.id, createdAt: { gt: new Date(current.getTime() - ttlMs) } },
      });
      if (recent >= 5) return reply.code(429).send(fail("CHALLENGE_RATE_LIMITED", request.id));
      const expiresAt = new Date(current.getTime() + ttlMs);
      const message = newWalletChallenge(input.data.address, webOrigin, expiresAt);
      const challenge = await prisma!.walletChallenge.create({
        data: { ownerId: identity.id, chain: "SOLANA", address: input.data.address, message, expiresAt },
        select: { id: true },
      });
      return reply.code(201).send({
        challengeId: challenge.id,
        message,
        expiresAt: expiresAt.toISOString(),
        statement: "This signature proves wallet ownership; it cannot authorise a trade.",
      });
    } catch (err) {
      request.log.error({ err }, "wallet challenge creation failed");
      return reply.code(503).send(fail("CHALLENGE_UNAVAILABLE", request.id));
    }
  });

  app.post("/v1/owner/wallets/verify", async (request, reply) => {
    const subject = await owner(request, reply);
    if (!subject) return;
    const input = proofInput.safeParse(request.body);
    if (!input.success) return reply.code(400).send(fail("INVALID_WALLET_PROOF", request.id));
    try {
      const identity = await prisma!.user.findUnique({
        where: { authSubject: subject }, select: { id: true, status: true },
      });
      if (!identity || identity.status !== "ACTIVE") return reply.code(403).send(fail("OWNER_DISABLED", request.id));
      const challenge = await prisma!.walletChallenge.findFirst({
        where: { id: input.data.challengeId, ownerId: identity.id, consumedAt: null, expiresAt: { gt: now() } },
      });
      if (!challenge || challenge.chain !== "SOLANA" ||
          !verifySolanaWalletProof(challenge.address, challenge.message, input.data.signature))
        return reply.code(400).send(fail("PROOF_INVALID_OR_EXPIRED", request.id));
      const existing = await prisma!.verifiedWallet.findUnique({
        where: { chain_address: { chain: "SOLANA", address: challenge.address } },
        select: { ownerId: true },
      });
      if (existing && existing.ownerId !== identity.id)
        return reply.code(409).send(fail("WALLET_ALREADY_BOUND", request.id));
      const wallet = await prisma!.$transaction(async tx => {
        const consumed = await tx.walletChallenge.updateMany({
          where: { id: challenge.id, ownerId: identity.id, consumedAt: null, expiresAt: { gt: now() } },
          data: { consumedAt: now() },
        });
        if (consumed.count !== 1) return null;
        const result = await tx.verifiedWallet.upsert({
          where: { chain_address: { chain: "SOLANA", address: challenge.address } },
          create: { ownerId: identity.id, chain: "SOLANA", address: challenge.address },
          update: { status: "ACTIVE", lastVerifiedAt: now() },
          select: { id: true, chain: true, address: true, status: true },
        });
        await tx.auditEvent.create({
          data: { actorType: "OIDC_USER", actorId: subject, action: "wallet.proof_verified",
            targetType: "VerifiedWallet", targetId: result.id, correlationId: request.id,
            payloadHash: (await import("node:crypto")).createHash("sha256").update(challenge.message).digest("hex") },
        });
        return result;
      });
      if (!wallet) return reply.code(409).send(fail("CHALLENGE_REPLAYED", request.id));
      return { wallet, verified: true, tradingEnabled: false };
    } catch (err) {
      request.log.error({ err }, "wallet verification failed");
      return reply.code(409).send(fail("WALLET_VERIFICATION_CONFLICT", request.id));
    }
  });

  app.post<{ Params: { walletId: string } }>("/v1/owner/wallets/:walletId/assign", async (request, reply) => {
    const subject = await owner(request, reply);
    if (!subject) return;
    const walletId = uuid.safeParse(request.params.walletId);
    const input = assignInput.safeParse(request.body);
    if (!walletId.success || !input.success) return reply.code(400).send(fail("INVALID_ASSIGNMENT", request.id));
    try {
      const identity = await prisma!.user.findUnique({
        where: { authSubject: subject }, select: { id: true, status: true },
      });
      if (!identity || identity.status !== "ACTIVE") return reply.code(403).send(fail("OWNER_DISABLED", request.id));
      const [wallet, agent] = await Promise.all([
        prisma!.verifiedWallet.findFirst({ where: { id: walletId.data, ownerId: identity.id, status: "ACTIVE" } }),
        prisma!.agent.findFirst({ where: { id: input.data.agentId, ownerId: identity.id, status: "ACTIVE" } }),
      ]);
      if (!wallet || !agent) return reply.code(404).send(fail("WALLET_OR_AGENT_UNAVAILABLE", request.id));
      const link = await prisma!.$transaction(async tx => {
        const result = await tx.agentWalletLink.upsert({
          where: { walletId_agentId: { walletId: wallet.id, agentId: agent.id } },
          create: { walletId: wallet.id, agentId: agent.id, tradeEnabled: false },
          update: { status: "ACTIVE", tradeEnabled: false },
          select: { id: true, walletId: true, agentId: true, status: true, tradeEnabled: true },
        });
        await tx.auditEvent.create({
          data: { actorType: "OIDC_USER", actorId: subject, action: "wallet.assigned_to_agent",
            targetType: "AgentWalletLink", targetId: result.id, correlationId: request.id,
            payloadHash: (await import("node:crypto")).createHash("sha256").update(result.id).digest("hex") },
        });
        return result;
      });
      return { link, executionMode: "PAPER_ONLY" };
    } catch (err) {
      request.log.error({ err }, "wallet assignment failed");
      return reply.code(503).send(fail("ASSIGNMENT_UNAVAILABLE", request.id));
    }
  });

  app.post<{ Params: { walletId: string } }>("/v1/owner/wallets/:walletId/revoke", async (request, reply) => {
    const subject = await owner(request, reply);
    if (!subject) return;
    const walletId = uuid.safeParse(request.params.walletId);
    if (!walletId.success) return reply.code(400).send(fail("INVALID_WALLET", request.id));
    try {
      const identity = await prisma!.user.findUnique({
        where: { authSubject: subject }, select: { id: true, status: true },
      });
      if (!identity || identity.status !== "ACTIVE") return reply.code(403).send(fail("OWNER_DISABLED", request.id));
      const changed = await prisma!.$transaction(async tx => {
        const wallet = await tx.verifiedWallet.updateMany({
          where: { id: walletId.data, ownerId: identity.id, status: "ACTIVE" },
          data: { status: "REVOKED" },
        });
        if (wallet.count !== 1) return false;
        await tx.agentWalletLink.updateMany({ where: { walletId: walletId.data }, data: { status: "REVOKED", tradeEnabled: false } });
        await tx.auditEvent.create({
          data: { actorType: "OIDC_USER", actorId: subject, action: "wallet.revoked",
            targetType: "VerifiedWallet", targetId: walletId.data, correlationId: request.id,
            payloadHash: (await import("node:crypto")).createHash("sha256").update(walletId.data).digest("hex") },
        });
        return true;
      });
      if (!changed) return reply.code(404).send(fail("WALLET_NOT_ACTIVE", request.id));
      return { revoked: true, tradingEnabled: false };
    } catch (err) {
      request.log.error({ err }, "wallet revocation failed");
      return reply.code(503).send(fail("REVOCATION_UNAVAILABLE", request.id));
    }
  });
}
