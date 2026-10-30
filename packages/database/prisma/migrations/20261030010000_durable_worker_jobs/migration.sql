CREATE TYPE "WorkerJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'RETRY_WAIT', 'DEAD_LETTER', 'CANCELLED');

CREATE TABLE "WorkerJob" (
    "id" UUID NOT NULL,
    "queue" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WorkerJobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" VARCHAR(200),
    "idempotencyKey" VARCHAR(200),
    "lastError" VARCHAR(2000),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkerJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerJob_queue_idempotencyKey_key" ON "WorkerJob"("queue", "idempotencyKey");
CREATE INDEX "WorkerJob_queue_status_availableAt_priority_idx" ON "WorkerJob"("queue", "status", "availableAt", "priority");
CREATE INDEX "WorkerJob_status_lockedAt_idx" ON "WorkerJob"("status", "lockedAt");
