import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { WorkerQueue } from "./worker-queue.js";

const databaseUrl = process.env.DATABASE_URL;
const integrationIt = databaseUrl ? it : it.skip;
const prisma = databaseUrl ? new PrismaClient() : null;

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("WorkerQueue PostgreSQL integration", () => {
  integrationIt(
    "completes a claimed lease when PostgreSQL stores sub-millisecond timestamp precision",
    async () => {
      if (!prisma)
        throw new Error(
          "DATABASE_URL must be configured for this integration test",
        );

      const queue = new WorkerQueue(prisma);
      const queueName = `lease-precision-${randomUUID()}`;
      let jobId: string | undefined;

      try {
        const enqueued = await queue.enqueue({
          queue: queueName,
          kind: "lease-precision-regression",
          payload: { test: true },
          maxAttempts: 1,
        });
        jobId = enqueued.id;

        const claimed = await queue.claim(queueName, "integration-worker");
        expect(claimed).not.toBeNull();
        expect(claimed?.id).toBe(jobId);
        expect(claimed?.lockedAt).toBeInstanceOf(Date);

        // PostgreSQL CURRENT_TIMESTAMP can retain microseconds, while JavaScript
        // Date (and Prisma's returned Date) represents only milliseconds.
        // The lease token returned by claim must still authorise completion.
        const completed = await queue.complete(
          claimed!.id,
          claimed!.lockedBy!,
          claimed!.lockedAt!,
        );

        expect(completed).toBe(true);
        const persisted = await prisma.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS "status"
          FROM "WorkerJob"
          WHERE "id" = ${jobId}::uuid
        `;
        expect(persisted[0]?.status).toBe("SUCCEEDED");
      } finally {
        if (jobId) {
          await prisma.$executeRaw`DELETE FROM "WorkerJob" WHERE "id" = ${jobId}::uuid`;
        }
      }
    },
    15_000,
  );

  integrationIt(
    "reclaims an expired lease with a new fencing token and dead-letters an exhausted crashed attempt",
    async () => {
      if (!prisma)
        throw new Error(
          "DATABASE_URL must be configured for this integration test",
        );

      const queue = new WorkerQueue(prisma, { leaseMs: 1_000 });
      const queueName = `lease-recovery-${randomUUID()}`;
      let jobId: string | undefined;

      try {
        const enqueued = await queue.enqueue({
          queue: queueName,
          kind: "lease-recovery-regression",
          payload: { test: true },
          maxAttempts: 2,
        });
        jobId = enqueued.id;

        const firstClaim = await queue.claim(queueName, "worker-one");
        expect(firstClaim?.id).toBe(jobId);
        expect(firstClaim?.attempts).toBe(1);

        await prisma.$executeRaw`
          UPDATE "WorkerJob"
          SET "lockedAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE "id" = ${jobId}::uuid
        `;
        const expiredLease = await prisma.$queryRaw<Array<{ lockedAt: Date }>>`
          SELECT "lockedAt" FROM "WorkerJob" WHERE "id" = ${jobId}::uuid
        `;
        await expect(
          queue.heartbeat(
            jobId,
            firstClaim!.lockedBy!,
            expiredLease[0]!.lockedAt,
          ),
        ).resolves.toBeNull();

        const secondClaim = await queue.claim(queueName, "worker-two");
        expect(secondClaim?.id).toBe(jobId);
        expect(secondClaim?.attempts).toBe(2);
        expect(secondClaim?.lockedBy).not.toBe(firstClaim?.lockedBy);

        // The old owner must not mutate state after another worker reclaims it.
        await expect(
          queue.complete(
            firstClaim!.id,
            firstClaim!.lockedBy!,
            firstClaim!.lockedAt!,
          ),
        ).resolves.toBe(false);

        await prisma.$executeRaw`
          UPDATE "WorkerJob"
          SET "lockedAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE "id" = ${jobId}::uuid
        `;

        // The next claim reaps a crashed final attempt before selecting work.
        await expect(
          queue.claim(queueName, "worker-three"),
        ).resolves.toBeNull();
        const persisted = await prisma.$queryRaw<
          Array<{ status: string; attempts: number }>
        >`
          SELECT "status"::text AS "status", "attempts"
          FROM "WorkerJob"
          WHERE "id" = ${jobId}::uuid
        `;
        expect(persisted[0]).toEqual({ status: "DEAD_LETTER", attempts: 2 });
      } finally {
        if (jobId) {
          await prisma.$executeRaw`DELETE FROM "WorkerJob" WHERE "id" = ${jobId}::uuid`;
        }
      }
    },
    15_000,
  );

  integrationIt(
    "rolls back an enqueue performed through a transaction-scoped database client",
    async () => {
      if (!prisma)
        throw new Error(
          "DATABASE_URL must be configured for this integration test",
        );

      let jobId: string | undefined;
      const queueName = `transaction-rollback-${randomUUID()}`;

      try {
        await expect(
          prisma.$transaction(async (tx) => {
            const queue = new WorkerQueue(tx);
            const enqueued = await queue.enqueue({
              queue: queueName,
              kind: "transaction-rollback-regression",
              payload: { test: true },
            });
            jobId = enqueued.id;
            throw new Error("force transaction rollback");
          }),
        ).rejects.toThrow("force transaction rollback");

        expect(jobId).toBeDefined();
        const persisted = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS "count"
          FROM "WorkerJob"
          WHERE "id" = ${jobId}::uuid
        `;
        expect(persisted[0]?.count).toBe(0n);
      } finally {
        if (jobId) {
          await prisma.$executeRaw`DELETE FROM "WorkerJob" WHERE "id" = ${jobId}::uuid`;
        }
      }
    },
    15_000,
  );
});
