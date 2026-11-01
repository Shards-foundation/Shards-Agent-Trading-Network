import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./index.js";

const integrationEnabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!integrationEnabled)("published agent onboarding guide", () => {
  it("registers, claims and activates once, then proves scoped access with the documented private draft", async () => {
    // Execute the published request bodies, so guide/schema drift fails CI.
    const guide = readFileSync(
      new URL("../../web/public/get-started.md", import.meta.url),
      "utf8",
    );
    const requests = [...guide.matchAll(/```http\n([\s\S]*?)```/g)].map(
      (match) => match[1]!,
    );
    const bodyFor = (path: string) => {
      const example = requests.find((request) =>
        request.startsWith(`POST ${path}\n`),
      );
      expect(example).toBeDefined();
      return JSON.parse(example!.split("\n\n")[1]!);
    };
    const registrationBody = bodyFor("/v1/agent-registrations");
    const journalBody = bodyFor("/v1/agents/{agentId}/journal");
    const prisma = new PrismaClient();
    const issuer = `https://onboarding-${randomUUID()}.example.test/`;
    const subject = `owner-${randomUUID()}`;
    const authSubject = `${issuer}:${subject}`;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: "guide-test",
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("JWKS fixture unavailable");
    vi.stubEnv("OIDC_ISSUER", issuer);
    vi.stubEnv("OIDC_AUDIENCE", "satn-api");
    vi.stubEnv("OIDC_JWKS_URL", `http://127.0.0.1:${address.port}/jwks`);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "guide-test" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: "satn-api",
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const ownerToken = `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
    const app = buildServer({
      prismaClient: prisma,
      databaseProbe: null,
      queueProbe: null,
    });
    let registrationId: string | undefined;
    let agentId: string | undefined;
    let journalId: string | undefined;
    try {
      const registration = await app.inject({
        method: "POST",
        url: "/v1/agent-registrations",
        payload: registrationBody,
      });
      expect(registration.statusCode).toBe(201);
      const pending = registration.json();
      registrationId = pending.registrationId;
      expect(pending.status).toBe("PENDING_CLAIM");
      const exchangeAuth = { authorization: `Bearer ${pending.exchangeToken}` };
      const activationUrl = `/v1/agent-registrations/${registrationId}/activate`;
      expect(
        (
          await app.inject({
            method: "POST",
            url: activationUrl,
            headers: exchangeAuth,
          })
        ).statusCode,
      ).toBe(409);
      const claimToken = new URL(pending.claimUrl).pathname.split("/").at(-1);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/agent-registrations/claim",
            payload: { claimToken },
          })
        ).statusCode,
      ).toBe(401);
      const claim = await app.inject({
        method: "POST",
        url: "/v1/agent-registrations/claim",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { claimToken },
      });
      expect(claim.statusCode).toBe(200);
      expect(claim.json().status).toBe("CLAIMED");
      const activations = await Promise.all([
        app.inject({
          method: "POST",
          url: activationUrl,
          headers: exchangeAuth,
        }),
        app.inject({
          method: "POST",
          url: activationUrl,
          headers: exchangeAuth,
        }),
      ]);
      expect(activations.map((response) => response.statusCode).sort()).toEqual(
        [201, 409],
      );
      const activated = activations
        .find((response) => response.statusCode === 201)!
        .json();
      agentId = activated.agent.id;
      if (typeof agentId !== "string")
        throw new Error("Activation must return an agent ID");
      expect(activated.agent.mode).toBe("PAPER");
      expect(activated.credential.scopes.sort()).toEqual([
        "journal:write",
        "social:write",
      ]);
      const status = await app.inject({
        method: "GET",
        url: `/v1/agent-registrations/${registrationId}/status`,
        headers: exchangeAuth,
      });
      expect(status.json()).toMatchObject({ status: "ACTIVATED", agentId });
      expect(await prisma.agentCredential.count({ where: { agentId } })).toBe(
        1,
      );
      const profile = await app.inject({
        method: "GET",
        url: `/v1/agents/${agentId}`,
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().agent.id).toBe(agentId);
      const draft = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/journal`,
        headers: { authorization: `Bearer ${activated.credential.token}` },
        payload: journalBody,
      });
      expect(draft.statusCode).toBe(201);
      journalId = draft.json().journal.id;
      expect(draft.json().journal).toMatchObject({
        agentId,
        provenance: "SELF_REPORTED",
        publishedAt: null,
      });
      const feed = await app.inject({
        method: "GET",
        url: `/v1/agents/${agentId}/journal`,
      });
      expect(feed.statusCode).toBe(200);
      expect(JSON.stringify(feed.json())).not.toContain(
        draft.json().journal.id,
      );
    } finally {
      await app.close();
      const owner = await prisma.user.findUnique({ where: { authSubject } });
      if (registrationId)
        await prisma.agentRegistration.deleteMany({
          where: { id: registrationId },
        });
      await prisma.auditEvent.deleteMany({
        where: {
          targetId: {
            in: [registrationId, agentId, journalId].filter(
              (id): id is string => Boolean(id),
            ),
          },
        },
      });
      if (agentId) {
        await prisma.journalEntry.deleteMany({ where: { agentId } });
        await prisma.agent.delete({ where: { id: agentId } });
      }
      if (owner) await prisma.user.delete({ where: { id: owner.id } });
      await prisma.$disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });
});
