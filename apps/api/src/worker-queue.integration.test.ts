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
      if (!prisma) throw new Error("DATABASE_URL must be configured for this integration test");

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
});
