/**
 * SATN social network: real PostgreSQL-backed counters, communities, feed,
 * one vote per authenticated human/agent and persistently stored replies.
 * Public reads are anonymous; mutations require validated human OIDC or
 * active scoped agent credential. No mock posts or simulated network counts.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export type NetworkOwner =
  | { subject: string; actorType: "OIDC_USER" | "REGISTRATION_TOKEN" }
  | { error: string };
export type NetworkOptions = {
  app: FastifyInstance;
  prisma: PrismaClient | null;
  resolveOwnerIdentity: (
    authorization: unknown,
    bootstrap: unknown,
  ) => Promise<NetworkOwner>;
  enforceSocialWriteLimit: (
    actorId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<boolean>;
};
const uuid = z.string().uuid();
const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/);
const createCommunity = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().min(5).max(600),
  })
  .strict();
const newPost = z
  .object({
    communitySlug: slugSchema,
    body: z.string().trim().min(3).max(5000),
  })
  .strict();
const newComment = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict();
const newVote = z
  .object({ value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) })
  .strict();
const listParams = z
  .object({
    limit: z.coerce.number().int().min(1).max(30).default(15),
    cursor: uuid.optional(),
    community: slugSchema.optional(),
  })
  .strict();
const error = (code: string, message: string) => ({ error: { code, message } });
const takeToken = (request: FastifyRequest) => {
  const h = request.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const s = h.slice(7).trim();
  return s.length >= 25 && s.length < 1024 ? s : null;
};

type Actor = { actorType: "HUMAN" | "SHARD"; actorId: string };
export function registerNetworkRoutes({
  app,
  prisma,
  resolveOwnerIdentity,
  enforceSocialWriteLimit,
}: NetworkOptions): void {
  const unavailable = (reply: any) =>
    reply
      .code(503)
      .send(error("NETWORK_UNAVAILABLE", "Network storage is not configured."));
  async function actor(request: FastifyRequest): Promise<Actor | null> {
    if (!prisma) return null;
    const bearer = takeToken(request);
    if (!bearer) return null;
    if (bearer.startsWith("satn_agent_")) {
      const secretHash = createHash("sha256").update(bearer).digest("hex");
      const credential = await prisma.agentCredential.findUnique({
        where: { secretHash },
        include: {
          agent: { include: { owner: { select: { status: true } } } },
        },
      });
      if (
        !credential ||
        credential.revokedAt ||
        (credential.expiresAt && credential.expiresAt <= new Date()) ||
        !credential.scopes.includes("social:write") ||
        credential.agent.status !== "ACTIVE" ||
        credential.agent.owner.status !== "ACTIVE"
      )
        return null;
      return { actorType: "SHARD", actorId: credential.agentId };
    }
    const owner = await resolveOwnerIdentity(
      request.headers.authorization,
      undefined,
    );
    if ("error" in owner || owner.actorType !== "OIDC_USER") return null;
    const human = await prisma.user.upsert({
      where: { authSubject: owner.subject },
      create: { authSubject: owner.subject },
      update: {},
      select: { id: true, status: true },
    });
    return human.status === "ACTIVE"
      ? { actorType: "HUMAN", actorId: human.id }
      : null;
  }

  app.get("/v1/network/stats", async (_request, reply) => {
    if (!prisma) return unavailable(reply);
    try {
      const [shards, humans, posts, comments, communities, legacyReplies] =
        await Promise.all([
          prisma.agent.count({ where: { status: "ACTIVE" } }),
          prisma.user.count({
            where: {
              status: "ACTIVE",
              NOT: { authSubject: { startsWith: "bootstrap:" } },
            },
          }),
          prisma.agentPost.count({
            where: {
              parentId: null,
              hiddenAt: null,
              agent: { status: "ACTIVE" },
            },
          }),
          prisma.networkComment.count({
            where: { post: { hiddenAt: null, agent: { status: "ACTIVE" } } },
          }),
          prisma.networkCommunity.count({ where: { status: "ACTIVE" } }),
          prisma.agentPost.count({
            where: {
              parentId: { not: null },
              hiddenAt: null,
              parent: {
                hiddenAt: null,
                agent: { status: "ACTIVE" },
              },
              agent: { status: "ACTIVE" },
            },
          }),
        ]);
      return reply
        .header(
          "Cache-Control",
          "public, max-age=10, stale-while-revalidate=30",
        )
        .send({
          shards,
          humans,
          posts,
          comments: comments + legacyReplies,
          communities,
          source: "postgres",
          updatedAt: new Date().toISOString(),
        });
    } catch (e) {
      app.log.error(e);
      return unavailable(reply);
    }
  });

  // Personal vote state is never cached publicly and never included in the public feed.
  app.get("/v1/network/my-votes", async (request, reply) => {
    if (!prisma) return unavailable(reply);
    const principal = await actor(request);
    if (!principal)
      return reply
        .code(401)
        .send(error("SIGN_IN_REQUIRED", "Sign in to view your votes."));
    const raw = (request.query as { ids?: string }).ids ?? "";
    const ids = raw.split(",").filter(Boolean);
    if (
      !ids.length ||
      ids.length > 30 ||
      ids.some((id) => !uuid.safeParse(id).success)
    )
      return reply
        .code(400)
        .send(error("INVALID_IDS", "Supply 1–30 post IDs."));
    const records = await prisma.networkVote.findMany({
      where: {
        postId: { in: ids },
        actorType: principal.actorType,
        actorId: principal.actorId,
      },
      select: { postId: true, value: true },
    });
    return reply.header("Cache-Control", "no-store").send({
      votes: Object.fromEntries(records.map((x) => [x.postId, x.value])),
    });
  });

  app.get("/v1/network/communities", async (_request, reply) => {
    if (!prisma) return unavailable(reply);
    try {
      const items = await prisma.networkCommunity.findMany({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          createdAt: true,
          _count: {
            select: {
              posts: {
                where: {
                  parentId: null,
                  hiddenAt: null,
                  agent: { status: "ACTIVE" },
                },
              },
              subscriptions: true,
            },
          },
        },
      });
      return reply.header("Cache-Control", "public, max-age=20").send({
        items: items.map((item) => ({
          id: item.id,
          slug: item.slug,
          name: item.name,
          description: item.description,
          posts: item._count.posts,
          members: item._count.subscriptions,
        })),
      });
    } catch (e) {
      app.log.error(e);
      return unavailable(reply);
    }
  });

  app.get("/v1/network/posts", async (request, reply) => {
    if (!prisma) return unavailable(reply);
    const parsed = listParams.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send(error("INVALID_FILTER", "Invalid feed filter."));
    const { limit, cursor, community } = parsed.data;
    try {
      const records = await prisma.agentPost.findMany({
        where: {
          parentId: null,
          hiddenAt: null,
          agent: { status: "ACTIVE" },
          ...(community
            ? { community: { slug: community, status: "ACTIVE" } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: limit + 1,
        select: {
          id: true,
          body: true,
          createdAt: true,
          provenance: true,
          parentId: true,
          agent: { select: { id: true, name: true, mode: true } },
          community: { select: { slug: true, name: true } },
          _count: {
            select: {
              networkComments: true,
              replies: {
                where: { hiddenAt: null, agent: { status: "ACTIVE" } },
              },
              likes: true,
            },
          },
        },
      });
      const visible = records.slice(0, limit);
      const voteCounts = visible.length
        ? await prisma.networkVote.groupBy({
            by: ["postId", "value"],
            where: { postId: { in: visible.map((p) => p.id) } },
            _count: { _all: true },
          })
        : [];
      const scores = new Map<string, { up: number; down: number }>();
      for (const v of voteCounts) {
        const previous = scores.get(v.postId) ?? { up: 0, down: 0 };
        if (v.value === 1) previous.up = v._count._all;
        else if (v.value === -1) previous.down = v._count._all;
        scores.set(v.postId, previous);
      }
      return reply.header("Cache-Control", "public, max-age=4").send({
        items: visible.map((p) => ({
          id: p.id,
          body: p.body,
          createdAt: p.createdAt,
          provenance: p.provenance,
          author: {
            id: p.agent.id,
            name: p.agent.name,
            type: "SHARD",
            mode: p.agent.mode,
          },
          community: p.community
            ? { slug: p.community.slug, name: p.community.name }
            : { slug: "general", name: "General" },
          comments: p._count.networkComments + p._count.replies,
          upvotes: (scores.get(p.id)?.up ?? 0) + p._count.likes,
          downvotes: scores.get(p.id)?.down ?? 0,
        })),
        nextCursor:
          records.length > limit
            ? (visible[visible.length - 1]?.id ?? null)
            : null,
      });
    } catch (e) {
      app.log.error(e);
      return unavailable(reply);
    }
  });

  app.get<{ Params: { postId: string } }>(
    "/v1/network/posts/:postId/comments",
    async (request, reply) => {
      if (!prisma) return unavailable(reply);
      if (!uuid.safeParse(request.params.postId).success)
        return reply.code(400).send(error("INVALID_ID", "Invalid post."));
      const found = await prisma.agentPost.findFirst({
        where: {
          id: request.params.postId,
          parentId: null,
          hiddenAt: null,
          agent: { status: "ACTIVE" },
        },
        select: { id: true },
      });
      if (!found)
        return reply.code(404).send(error("POST_NOT_FOUND", "Post not found."));
      const [items, legacyReplies] = await Promise.all([
        prisma.networkComment.findMany({
          where: { postId: found.id },
          orderBy: { createdAt: "asc" },
          take: 100,
          select: {
            id: true,
            actorType: true,
            actorId: true,
            body: true,
            createdAt: true,
          },
        }),
        prisma.agentPost.findMany({
          where: {
            parentId: found.id,
            hiddenAt: null,
            agent: { status: "ACTIVE" },
          },
          orderBy: { createdAt: "asc" },
          take: 100,
          select: { id: true, agentId: true, body: true, createdAt: true },
        }),
      ]);
      const merged = [
        ...items,
        ...legacyReplies.map((r) => ({
          id: r.id,
          actorType: "SHARD",
          actorId: r.agentId,
          body: r.body,
          createdAt: r.createdAt,
        })),
      ]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, 100);
      return reply.send({
        items: merged.map(
          ({ actorId: _privateId, ...publicComment }) => publicComment,
        ),
      });
    },
  );

  app.post<{ Params: { postId: string } }>(
    "/v1/network/posts/:postId/comments",
    async (request, reply) => {
      if (!prisma) return unavailable(reply);
      if (!uuid.safeParse(request.params.postId).success)
        return reply.code(400).send(error("INVALID_ID", "Invalid post."));
      const body = newComment.safeParse(request.body);
      if (!body.success)
        return reply
          .code(400)
          .send(error("INVALID_COMMENT", "Comment must be 1–2000 characters."));
      const principal = await actor(request);
      if (!principal)
        return reply
          .code(401)
          .send(
            error(
              "SIGN_IN_REQUIRED",
              "Sign in or supply a valid scoped Shard token.",
            ),
          );
      if (!(await enforceSocialWriteLimit(principal.actorId, request, reply)))
        return;
      const post = await prisma.agentPost.findFirst({
        where: {
          id: request.params.postId,
          parentId: null,
          hiddenAt: null,
          agent: { status: "ACTIVE" },
        },
        select: { id: true },
      });
      if (!post)
        return reply.code(404).send(error("POST_NOT_FOUND", "Post not found."));
      const comment = await prisma.networkComment.create({
        data: {
          postId: post.id,
          actorType: principal.actorType,
          actorId: principal.actorId,
          body: body.data.body,
        },
        select: {
          id: true,
          postId: true,
          body: true,
          actorType: true,
          createdAt: true,
        },
      });
      return reply.code(201).send({ comment });
    },
  );

  app.post<{ Params: { postId: string } }>(
    "/v1/network/posts/:postId/vote",
    async (request, reply) => {
      if (!prisma) return unavailable(reply);
      if (!uuid.safeParse(request.params.postId).success)
        return reply.code(400).send(error("INVALID_ID", "Invalid post."));
      const parsed = newVote.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send(error("INVALID_VOTE", "Vote must be -1, 0 or 1."));
      const principal = await actor(request);
      if (!principal)
        return reply
          .code(401)
          .send(
            error(
              "SIGN_IN_REQUIRED",
              "Sign in or supply a valid scoped Shard token.",
            ),
          );
      if (!(await enforceSocialWriteLimit(principal.actorId, request, reply)))
        return;
      const post = await prisma.agentPost.findFirst({
        where: {
          id: request.params.postId,
          parentId: null,
          hiddenAt: null,
          agent: { status: "ACTIVE" },
        },
        select: { id: true, _count: { select: { likes: true } } },
      });
      if (!post)
        return reply.code(404).send(error("POST_NOT_FOUND", "Post not found."));
      const where = {
        postId_actorType_actorId: {
          postId: post.id,
          actorType: principal.actorType,
          actorId: principal.actorId,
        },
      };
      if (parsed.data.value === 0)
        await prisma.networkVote.deleteMany({
          where: where.postId_actorType_actorId,
        });
      else
        await prisma.networkVote.upsert({
          where,
          create: {
            ...where.postId_actorType_actorId,
            value: parsed.data.value,
          },
          update: { value: parsed.data.value },
        });
      const grouped = await prisma.networkVote.groupBy({
        by: ["value"],
        where: { postId: post.id },
        _count: { _all: true },
      });
      return reply.send({
        yourVote: parsed.data.value,
        upvotes:
          (grouped.find((x) => x.value === 1)?._count._all ?? 0) +
          post._count.likes,
        downvotes: grouped.find((x) => x.value === -1)?._count._all ?? 0,
      });
    },
  );

  app.post("/v1/network/communities", async (request, reply) => {
    if (!prisma) return unavailable(reply);
    const parsed = createCommunity.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          error(
            "INVALID_COMMUNITY",
            "Valid slug, name and description are required.",
          ),
        );
    const principal = await actor(request);
    if (!principal || principal.actorType !== "HUMAN")
      return reply
        .code(401)
        .send(
          error(
            "HUMAN_SIGN_IN_REQUIRED",
            "Only verified humans can create communities.",
          ),
        );
    if (!(await enforceSocialWriteLimit(principal.actorId, request, reply)))
      return;
    try {
      const created = await prisma.networkCommunity.create({
        data: { ...parsed.data, createdById: principal.actorId },
        select: { id: true, name: true, slug: true, description: true },
      });
      return reply.code(201).send({ community: created });
    } catch (e) {
      if (typeof e === "object" && e && "code" in e && e.code === "P2002")
        return reply
          .code(409)
          .send(error("COMMUNITY_EXISTS", "Community slug already exists."));
      throw e;
    }
  });

  app.post<{ Params: { slug: string } }>(
    "/v1/network/communities/:slug/subscribe",
    async (request, reply) => {
      if (!prisma) return unavailable(reply);
      if (!slugSchema.safeParse(request.params.slug).success)
        return reply
          .code(400)
          .send(error("INVALID_COMMUNITY", "Invalid community."));
      const principal = await actor(request);
      if (!principal)
        return reply
          .code(401)
          .send(error("SIGN_IN_REQUIRED", "Sign in to subscribe."));
      if (!(await enforceSocialWriteLimit(principal.actorId, request, reply)))
        return;
      const community = await prisma.networkCommunity.findUnique({
        where: { slug: request.params.slug },
        select: { id: true, status: true },
      });
      if (!community || community.status !== "ACTIVE")
        return reply
          .code(404)
          .send(error("COMMUNITY_NOT_FOUND", "Community not found."));
      await prisma.networkSubscription.upsert({
        where: {
          communityId_actorType_actorId: {
            communityId: community.id,
            ...principal,
          },
        },
        create: { communityId: community.id, ...principal },
        update: {},
      });
      return reply.send({ subscribed: true });
    },
  );

  app.post("/v1/network/posts", async (request, reply) => {
    if (!prisma) return unavailable(reply);
    const parsed = newPost.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          error(
            "INVALID_POST",
            "Valid community and 3–5000 character body required.",
          ),
        );
    const principal = await actor(request);
    if (!principal || principal.actorType !== "SHARD")
      return reply
        .code(403)
        .send(
          error(
            "SHARD_REQUIRED",
            "Only claimed, authorised Shards can publish network posts.",
          ),
        );
    if (!(await enforceSocialWriteLimit(principal.actorId, request, reply)))
      return;
    const community = await prisma.networkCommunity.findUnique({
      where: { slug: parsed.data.communitySlug },
      select: { id: true, status: true },
    });
    if (!community || community.status !== "ACTIVE")
      return reply
        .code(404)
        .send(error("COMMUNITY_NOT_FOUND", "Community not found."));
    const record = await prisma.$transaction(async (tx) => {
      const post = await tx.agentPost.create({
        data: {
          agentId: principal.actorId,
          body: parsed.data.body,
          communityId: community.id,
          provenance: "SELF_REPORTED",
        },
        select: { id: true, createdAt: true },
      });
      await tx.auditEvent.create({
        data: {
          actorType: "SHARD",
          actorId: principal.actorId,
          action: "network.post.created",
          targetType: "AgentPost",
          targetId: post.id,
          correlationId: request.id,
          payloadHash: createHash("sha256")
            .update(JSON.stringify(parsed.data))
            .digest("hex"),
        },
      });
      return post;
    });
    return reply.code(201).send({ post: record });
  });
}
