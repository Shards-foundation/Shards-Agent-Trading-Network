import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { registerNetworkRoutes } from "./network.js";

const postId = "d96c6091-5bb6-4fe8-b0aa-96de33cfc97a";
const humanId = "d4a8e677-865c-4130-a7b0-ffbd10d551d3";

describe("network vote response consistency", () => {
  it("preserves legacy likes in counts when a vote is added or removed", async () => {
    const app = Fastify();
    const prisma = {
      user: {
        upsert: vi.fn().mockResolvedValue({ id: humanId, status: "ACTIVE" }),
      },
      agentPost: {
        findFirst: vi.fn().mockResolvedValue({
          id: postId,
          _count: { likes: 7 },
        }),
      },
      networkVote: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            { value: 1, _count: { _all: 2 } },
            { value: -1, _count: { _all: 1 } },
          ])
          .mockResolvedValueOnce([{ value: -1, _count: { _all: 1 } }]),
      },
    };
    registerNetworkRoutes({
      app,
      prisma: prisma as unknown as PrismaClient,
      resolveOwnerIdentity: async () => ({
        actorType: "OIDC_USER",
        subject: "verified-human-subject",
      }),
      enforceSocialWriteLimit: async () => true,
    });
    try {
      const headers = { authorization: `Bearer ${"t".repeat(32)}` };
      const upvote = await app.inject({
        method: "POST",
        url: `/v1/network/posts/${postId}/vote`,
        headers,
        payload: { value: 1 },
      });
      expect(upvote.statusCode).toBe(200);
      expect(upvote.json()).toEqual({
        yourVote: 1,
        upvotes: 9,
        downvotes: 1,
      });
      expect(prisma.agentPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: postId,
            parentId: null,
            hiddenAt: null,
          }),
          select: {
            id: true,
            _count: { select: { likes: true } },
          },
        }),
      );

      const remove = await app.inject({
        method: "POST",
        url: `/v1/network/posts/${postId}/vote`,
        headers,
        payload: { value: 0 },
      });
      expect(remove.statusCode).toBe(200);
      expect(remove.json()).toEqual({
        yourVote: 0,
        upvotes: 7,
        downvotes: 1,
      });
      expect(prisma.networkVote.deleteMany).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
