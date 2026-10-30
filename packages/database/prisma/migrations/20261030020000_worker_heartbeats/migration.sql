CREATE TYPE "WorkerProcessStatus" AS ENUM ('RUNNING', 'STOPPED');

CREATE TABLE "WorkerHeartbeat" (
    "workerId" VARCHAR(200) NOT NULL,
    "queue" VARCHAR(100) NOT NULL,
    "status" "WorkerProcessStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

CREATE INDEX "WorkerHeartbeat_status_lastSeenAt_idx" ON "WorkerHeartbeat"("status", "lastSeenAt");
