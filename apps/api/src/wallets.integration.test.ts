import {
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { encodeSolanaAddress } from "./wallet-crypto.js";
import { registerWalletRoutes } from "./wallets.js";

const integrationEnabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!integrationEnabled)(
  "OIDC operator wallet ownership and Shard assignment (PostgreSQL)",
  () => {
    const prisma = new PrismaClient();
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("verifies a one-use signature, rejects cross-tenant binding, assigns without execution authority, and revokes atomically", async () => {
      const runId = randomUUID();
      const subjectA = `wallet-integration-a:${runId}`;
      const subjectB = `wallet-integration-b:${runId}`;
      const first = await prisma.user.create({
        data: { authSubject: subjectA },
      });
      const second = await prisma.user.create({
        data: { authSubject: subjectB },
      });
      const agent = await prisma.agent.create({
        data: { ownerId: first.id, name: "Wallet integration Shard" },
      });
      const anotherAgent = await prisma.agent.create({
        data: { ownerId: second.id, name: "Other operator Shard" },
      });

      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const address = encodeSolanaAddress(
        publicKey.export({ format: "der", type: "spki" }).subarray(-32),
      );

      const app = Fastify({ logger: false });
      registerWalletRoutes({
        app,
        prisma,
        webOrigin: "https://satns.vercel.app",
        resolveOwnerIdentity: async authorization => {
          if (authorization === "Bearer operator-a")
            return { subject: subjectA, actorType: "OIDC_USER" };
          if (authorization === "Bearer operator-b")
            return { subject: subjectB, actorType: "OIDC_USER" };
          return { error: "INVALID" };
        },
      });
      const inject = (
        url: string,
        token: "operator-a" | "operator-b",
        payload?: unknown,
      ) =>
        app.inject({
          method: payload === undefined ? "GET" : "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          ...(payload === undefined ? {} : { payload }),
        });
      try {
        const challenge = await inject(
          "/v1/owner/wallets/challenge",
          "operator-a",
          { chain: "SOLANA", address },
        );
        expect(challenge.statusCode).toBe(201);
        const challengeBody = challenge.json();
        expect(challengeBody.message).toContain(
          "NO trading or spending authority",
        );
        expect(challengeBody.message).toContain("satns.vercel.app");
        expect(challengeBody.message).toContain(address);
        const signature = sign(
          null,
          Buffer.from(challengeBody.message, "utf8"),
          privateKey,
        ).toString("base64");

        const invalid = await inject(
          "/v1/owner/wallets/verify",
          "operator-a",
          { challengeId: challengeBody.challengeId, signature: "x".repeat(88) },
        );
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.code).toBe("PROOF_INVALID_OR_EXPIRED");

        const verified = await inject(
          "/v1/owner/wallets/verify",
          "operator-a",
          { challengeId: challengeBody.challengeId, signature },
        );
        expect(verified.statusCode).toBe(200);
        expect(verified.json()).toMatchObject({
          verified: true,
          tradingEnabled: false,
          wallet: { chain: "SOLANA", address, status: "ACTIVE" },
        });
        const walletId: string = verified.json().wallet.id;
        expect(verified.json().wallet).not.toHaveProperty("ownerId");

        const replay = await inject(
          "/v1/owner/wallets/verify",
          "operator-a",
          { challengeId: challengeBody.challengeId, signature },
        );
        expect(replay.statusCode).toBe(400);

        const otherChallenge = await inject(
          "/v1/owner/wallets/challenge",
          "operator-b",
          { chain: "SOLANA", address },
        );
        expect(otherChallenge.statusCode).toBe(201);
        const otherSignature = sign(
          null,
          Buffer.from(otherChallenge.json().message, "utf8"),
          privateKey,
        ).toString("base64");
        const otherClaim = await inject(
          "/v1/owner/wallets/verify",
          "operator-b",
          {
            challengeId: otherChallenge.json().challengeId,
            signature: otherSignature,
          },
        );
        expect(otherClaim.statusCode).toBe(409);
        expect(otherClaim.json().error.code).toBe("WALLET_ALREADY_BOUND");

        const crossAgent = await inject(
          `/v1/owner/wallets/${walletId}/assign`,
          "operator-a",
          { agentId: anotherAgent.id },
        );
        expect(crossAgent.statusCode).toBe(404);
        const crossWallet = await inject(
          `/v1/owner/wallets/${walletId}/assign`,
          "operator-b",
          { agentId: anotherAgent.id },
        );
        expect(crossWallet.statusCode).toBe(404);

        const assignment = await inject(
          `/v1/owner/wallets/${walletId}/assign`,
          "operator-a",
          { agentId: agent.id },
        );
        expect(assignment.statusCode).toBe(200);
        expect(assignment.json()).toMatchObject({
          executionMode: "PAPER_ONLY",
          link: { walletId, agentId: agent.id, tradeEnabled: false },
        });
        const repeated = await inject(
          `/v1/owner/wallets/${walletId}/assign`,
          "operator-a",
          { agentId: agent.id },
        );
        expect(repeated.statusCode).toBe(200);
        expect(
          await prisma.agentWalletLink.count({
            where: { walletId, agentId: agent.id },
          }),
        ).toBe(1);

        const registry = await inject(
          "/v1/owner/wallets",
          "operator-a",
        );
        expect(registry.statusCode).toBe(200);
        expect(registry.json().wallets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: walletId, address }),
          ]),
        );

        const revoked = await inject(
          `/v1/owner/wallets/${walletId}/revoke`,
          "operator-a",
          {},
        );
        expect(revoked.statusCode).toBe(200);
        expect(revoked.json()).toMatchObject({
          revoked: true,
          tradingEnabled: false,
        });
        const link = await prisma.agentWalletLink.findUniqueOrThrow({
          where: { walletId_agentId: { walletId, agentId: agent.id } },
        });
        expect(link.status).toBe("REVOKED");
        expect(link.tradeEnabled).toBe(false);
        const revokedAgain = await inject(
          `/v1/owner/wallets/${walletId}/revoke`,
          "operator-a",
          {},
        );
        expect(revokedAgain.statusCode).toBe(404);
        const linkAfterRevoke = await inject(
          `/v1/owner/wallets/${walletId}/assign`,
          "operator-a",
          { agentId: agent.id },
        );
        expect(linkAfterRevoke.statusCode).toBe(404);
      } finally {
        await app.close();
        await prisma.auditEvent.deleteMany({
          where: {
            actorType: "OIDC_USER",
            actorId: { in: [subjectA, subjectB] },
            action: { startsWith: "wallet." },
          },
        });
        await prisma.agentWalletLink.deleteMany({
          where: { agentId: { in: [agent.id, anotherAgent.id] } },
        });
        await prisma.verifiedWallet.deleteMany({
          where: { ownerId: { in: [first.id, second.id] } },
        });
        await prisma.walletChallenge.deleteMany({
          where: { ownerId: { in: [first.id, second.id] } },
        });
        await prisma.agent.deleteMany({
          where: { id: { in: [agent.id, anotherAgent.id] } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: [first.id, second.id] } },
        });
      }
    });
  },
);
