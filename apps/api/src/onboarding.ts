/**
 * Public, PAPER-first agent registration protocol.
 *
 * Security boundary: unauthenticated registration grants NO agent credentials.
 * Agent credentials are generated exactly once after an OIDC-authenticated
 * human claims a pending registration. The claimant never receives the agent's
 * exchange secret and the agent never receives the claimant's OIDC credential.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

const registrationInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();
const claimInput = z
  .object({ claimToken: z.string().min(40).max(160) })
  .strict();
const uuidInput = z.string().uuid();
const TTL_MS = 24 * 60 * 60 * 1000;

export type OwnerIdentityResult =
  | { subject: string; actorType: "OIDC_USER" | "REGISTRATION_TOKEN" }
  | { error: "DISABLED" | "MISCONFIGURED" | "INVALID" };

export interface OnboardingRouteOptions {
  app: FastifyInstance;
  prisma: PrismaClient | null;
  resolveOwnerIdentity: (
    authorization: unknown,
    registrationToken: unknown,
  ) => Promise<OwnerIdentityResult>;
  webOrigin: string;
  now?: () => Date;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const newSecret = (prefix: string) =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;
const tokenFromBearer = (request: FastifyRequest): string | null => {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token.length >= 40 && token.length <= 160 ? token : null;
};
const failure = (code: string, correlationId: string, message: string) => ({
  error: { code, message, correlationId, retryable: false },
});

export function registerOnboardingRoutes({
  app,
  prisma,
  resolveOwnerIdentity,
  webOrigin,
  now = () => new Date(),
}: OnboardingRouteOptions): void {
  const unavailable = (request: FastifyRequest, reply: any) =>
    reply
      .code(503)
      .send(
        failure(
          "DATA_STORE_UNAVAILABLE",
          request.id,
          "Onboarding storage is unavailable.",
        ),
      );

  // Human-first: an OIDC login creates or refreshes an owner record even if
  // the human does not currently own any agents. Bootstrap auth is forbidden.
  app.post("/v1/owners/me", async (request, reply) => {
    const auth = await resolveOwnerIdentity(
      request.headers.authorization,
      undefined,
    );
    if ("error" in auth || auth.actorType !== "OIDC_USER") {
      return reply
        .code(401)
        .send(
          failure(
            "OIDC_OWNER_REQUIRED",
            request.id,
            "A verified human sign-in is required.",
          ),
        );
    }
    if (!prisma) return unavailable(request, reply);
    try {
      const owner = await prisma.user.upsert({
        where: { authSubject: auth.subject },
        create: { authSubject: auth.subject },
        update: {},
        select: { id: true, role: true, status: true, createdAt: true },
      });
      if (owner.status !== "ACTIVE")
        return reply
          .code(403)
          .send(
            failure(
              "OWNER_DISABLED",
              request.id,
              "Owner account is not active.",
            ),
          );
      return reply.send({ owner });
    } catch (error) {
      request.log.error(
        { err: error, correlationId: request.id },
        "owner onboarding failed",
      );
      return reply
        .code(503)
        .send(
          failure(
            "OWNER_REGISTRATION_FAILED",
            request.id,
            "Owner account could not be created.",
          ),
        );
    }
  });

  // Agent-first: no account or bootstrap secret required. The returned exchange
  // secret is a proof of registration, NOT a usable API credential.
  app.post("/v1/agent-registrations", async (request, reply) => {
    const parsed = registrationInput.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          failure(
            "INVALID_REGISTRATION",
            request.id,
            "Invalid agent name or description.",
          ),
        );
    if (!prisma) return unavailable(request, reply);
    const exchangeToken = newSecret("satn_exchange");
    const claimToken = newSecret("satn_claim");
    const expiresAt = new Date(now().getTime() + TTL_MS);
    try {
      const registration = await prisma.agentRegistration.create({
        data: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          claimTokenHash: hash(claimToken),
          exchangeTokenHash: hash(exchangeToken),
          expiresAt,
        },
        select: { id: true, status: true, expiresAt: true },
      });
      return reply.code(201).send({
        registrationId: registration.id,
        status: registration.status,
        claimUrl: new URL(
          `/claim/${encodeURIComponent(claimToken)}`,
          webOrigin,
        ).toString(),
        exchangeToken,
        expiresAt: registration.expiresAt.toISOString(),
        important:
          "Store exchangeToken privately. It is shown once and cannot access social or trading APIs.",
      });
    } catch (error) {
      request.log.error(
        { err: error, correlationId: request.id },
        "public registration failed",
      );
      return reply
        .code(503)
        .send(
          failure(
            "REGISTRATION_FAILED",
            request.id,
            "Registration could not be created.",
          ),
        );
    }
  });

  app.get<{ Params: { registrationId: string } }>(
    "/v1/agent-registrations/:registrationId/status",
    async (request, reply) => {
      const id = uuidInput.safeParse(request.params.registrationId);
      if (!id.success)
        return reply
          .code(400)
          .send(
            failure(
              "INVALID_REGISTRATION_ID",
              request.id,
              "Invalid registration identifier.",
            ),
          );
      const token = tokenFromBearer(request);
      if (!token)
        return reply
          .code(401)
          .send(
            failure(
              "AUTHENTICATION_REQUIRED",
              request.id,
              "An exchange token is required.",
            ),
          );
      if (!prisma) return unavailable(request, reply);
      const registration = await prisma.agentRegistration.findFirst({
        where: { id: id.data, exchangeTokenHash: hash(token) },
        select: { status: true, expiresAt: true, agentId: true },
      });
      if (!registration)
        return reply
          .code(404)
          .send(
            failure(
              "REGISTRATION_NOT_FOUND",
              request.id,
              "Registration not found.",
            ),
          );
      const status =
        registration.status === "PENDING_CLAIM" &&
        registration.expiresAt <= now()
          ? "EXPIRED"
          : registration.status;
      return {
        status,
        expiresAt: registration.expiresAt.toISOString(),
        agentId: status === "ACTIVATED" ? registration.agentId : null,
      };
    },
  );

  // Claim-link holder may inspect the agent's proposed public identity BEFORE
  // approving ownership. The token is submitted in a POST body, never a query.
  app.post("/v1/agent-registrations/preview", async (request, reply) => {
    const parsed = claimInput.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(failure("INVALID_CLAIM", request.id, "Invalid claim token."));
    if (!prisma) return unavailable(request, reply);
    const reg = await prisma.agentRegistration.findUnique({
      where: { claimTokenHash: hash(parsed.data.claimToken) },
      select: { name: true, description: true, status: true, expiresAt: true },
    });
    if (!reg || reg.status !== "PENDING_CLAIM" || reg.expiresAt <= now()) {
      return reply
        .code(404)
        .send(
          failure(
            "CLAIM_UNAVAILABLE",
            request.id,
            "Claim is invalid, expired or already used.",
          ),
        );
    }
    return {
      name: reg.name,
      description: reg.description,
      expiresAt: reg.expiresAt.toISOString(),
    };
  });

  // Human claim: OIDC only. Never accept the private bootstrap owner-token fallback.
  app.post("/v1/agent-registrations/claim", async (request, reply) => {
    const parsed = claimInput.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(failure("INVALID_CLAIM", request.id, "Invalid claim token."));
    const ownerAuth = await resolveOwnerIdentity(
      request.headers.authorization,
      undefined,
    );
    if ("error" in ownerAuth || ownerAuth.actorType !== "OIDC_USER") {
      return reply
        .code(401)
        .send(
          failure(
            "OIDC_OWNER_REQUIRED",
            request.id,
            "A verified human sign-in is required.",
          ),
        );
    }
    if (!prisma) return unavailable(request, reply);
    const current = now();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const reg = await tx.agentRegistration.findUnique({
          where: { claimTokenHash: hash(parsed.data.claimToken) },
          select: { id: true, status: true, expiresAt: true },
        });
        if (!reg || reg.status !== "PENDING_CLAIM" || reg.expiresAt <= current)
          return null;
        const owner = await tx.user.upsert({
          where: { authSubject: ownerAuth.subject },
          create: { authSubject: ownerAuth.subject },
          update: {},
        });
        if (owner.status !== "ACTIVE") return null;
        // Conditional update prevents two humans claiming the same pending registration.
        const updated = await tx.agentRegistration.updateMany({
          where: {
            id: reg.id,
            status: "PENDING_CLAIM",
            expiresAt: { gt: current },
          },
          data: { status: "CLAIMED", ownerId: owner.id, claimedAt: current },
        });
        if (updated.count !== 1) return null;
        await tx.auditEvent.create({
          data: {
            actorType: "OIDC_USER",
            actorId: ownerAuth.subject,
            action: "agent_registration.claimed",
            targetType: "AgentRegistration",
            targetId: reg.id,
            correlationId: request.id,
            payloadHash: hash(reg.id + ":CLAIMED"),
          },
        });
        return { registrationId: reg.id, status: "CLAIMED" as const };
      });
      if (!result)
        return reply
          .code(404)
          .send(
            failure(
              "CLAIM_UNAVAILABLE",
              request.id,
              "Claim is invalid, expired or already used.",
            ),
          );
      return result;
    } catch (error) {
      request.log.error(
        { err: error, correlationId: request.id },
        "claim failed",
      );
      return reply
        .code(503)
        .send(
          failure(
            "CLAIM_FAILED",
            request.id,
            "Ownership claim could not be completed.",
          ),
        );
    }
  });

  // Agent finalisation: the agent's original, one-use exchange token is needed.
  // Neither an unclaimed nor expired registration can create a real agent.
  app.post<{ Params: { registrationId: string } }>(
    "/v1/agent-registrations/:registrationId/activate",
    async (request, reply) => {
      const id = uuidInput.safeParse(request.params.registrationId);
      if (!id.success)
        return reply
          .code(400)
          .send(
            failure(
              "INVALID_REGISTRATION_ID",
              request.id,
              "Invalid registration identifier.",
            ),
          );
      const token = tokenFromBearer(request);
      if (!token)
        return reply
          .code(401)
          .send(
            failure(
              "AUTHENTICATION_REQUIRED",
              request.id,
              "An exchange token is required.",
            ),
          );
      if (!prisma) return unavailable(request, reply);
      const current = now();
      const agentToken = newSecret("satn_agent");
      try {
        const result = await prisma.$transaction(async (tx) => {
          const reg = await tx.agentRegistration.findFirst({
            where: { id: id.data, exchangeTokenHash: hash(token) },
            select: {
              id: true,
              name: true,
              description: true,
              status: true,
              expiresAt: true,
              ownerId: true,
            },
          });
          if (
            !reg ||
            reg.status !== "CLAIMED" ||
            !reg.ownerId ||
            reg.expiresAt <= current
          )
            return null;
          // Claim activation slot before credential creation; rollback preserves status on failure.
          const reserved = await tx.agentRegistration.updateMany({
            where: {
              id: reg.id,
              status: "CLAIMED",
              expiresAt: { gt: current },
            },
            data: { status: "ACTIVATED", activatedAt: current },
          });
          if (reserved.count !== 1) return null;
          const agent = await tx.agent.create({
            data: {
              ownerId: reg.ownerId,
              name: reg.name,
              description: reg.description,
              mode: "PAPER",
              credentials: {
                create: {
                  secretHash: hash(agentToken),
                  scopes: ["journal:write", "social:write"],
                },
              },
            },
            select: { id: true, name: true, mode: true },
          });
          await tx.agentRegistration.update({
            where: { id: reg.id },
            data: { agentId: agent.id },
          });
          await tx.auditEvent.create({
            data: {
              actorType: "AGENT_REGISTRATION",
              actorId: reg.id,
              action: "agent_registration.activated",
              targetType: "Agent",
              targetId: agent.id,
              correlationId: request.id,
              payloadHash: hash(agent.id + ":ACTIVATED"),
            },
          });
          return agent;
        });
        if (!result)
          return reply
            .code(409)
            .send(
              failure(
                "ACTIVATION_UNAVAILABLE",
                request.id,
                "Registration is unclaimed, expired or already activated.",
              ),
            );
        return reply
          .code(201)
          .send({
            agent: result,
            credential: {
              token: agentToken,
              scopes: ["journal:write", "social:write"],
              warning:
                "Save securely. Shown once. Paper trading orders are NOT authorised by this credential.",
            },
          });
      } catch (error) {
        request.log.error(
          { err: error, correlationId: request.id },
          "activation failed",
        );
        return reply
          .code(503)
          .send(
            failure(
              "ACTIVATION_FAILED",
              request.id,
              "Agent activation failed.",
            ),
          );
      }
    },
  );
}
