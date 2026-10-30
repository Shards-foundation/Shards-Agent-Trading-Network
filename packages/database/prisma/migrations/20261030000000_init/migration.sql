-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgentMode" AS ENUM ('PAPER', 'READ_ONLY', 'LIVE_RESTRICTED', 'HALTED');

-- CreateEnum
CREATE TYPE "EvidenceProvenance" AS ENUM ('SIMULATED', 'SELF_REPORTED', 'IMPORTED', 'VENUE_VERIFIED', 'CHAIN_VERIFIED');

-- CreateEnum
CREATE TYPE "IntentMode" AS ENUM ('PAPER', 'READ_ONLY', 'LIVE_RESTRICTED');

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('RECEIVED', 'VALIDATED', 'RISK_REJECTED', 'RISK_APPROVED', 'PERMITTED', 'SUBMISSION_STARTED', 'SUBMISSION_UNKNOWN', 'ACKNOWLEDGED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED', 'EXPIRED', 'RECONCILIATION_REQUIRED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "RiskOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VenueOrderState" AS ENUM ('ACKNOWLEDGED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "authSubject" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "mode" "AgentMode" NOT NULL DEFAULT 'PAPER',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCredential" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "configHash" TEXT NOT NULL,
    "codeRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "strategyVersionId" UUID,
    "body" VARCHAR(10000) NOT NULL,
    "provenance" "EvidenceProvenance" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskPolicy" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "limits" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeIntent" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "venue" VARCHAR(64) NOT NULL,
    "instrument" VARCHAR(128) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "orderType" "OrderType" NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "limitPrice" DECIMAL(38,18),
    "mode" "IntentMode" NOT NULL DEFAULT 'PAPER',
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskDecision" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "outcome" "RiskOutcome" NOT NULL,
    "reasonCodes" TEXT[],
    "policyVersion" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueOrder" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "venue" VARCHAR(64) NOT NULL,
    "clientOrderId" VARCHAR(200) NOT NULL,
    "venueOrderId" TEXT,
    "state" "VenueOrderState" NOT NULL DEFAULT 'UNKNOWN',
    "submittedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" UUID NOT NULL,
    "venueOrderId" UUID NOT NULL,
    "fillRef" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL,
    "feeAsset" TEXT NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorType" VARCHAR(64) NOT NULL,
    "actorId" VARCHAR(200) NOT NULL,
    "action" VARCHAR(128) NOT NULL,
    "targetType" VARCHAR(64) NOT NULL,
    "targetId" VARCHAR(200) NOT NULL,
    "correlationId" VARCHAR(200) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceSnapshot" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mode" "IntentMode" NOT NULL,
    "provenance" "EvidenceProvenance" NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "methodologyVersion" TEXT NOT NULL,
    "pnlNet" DECIMAL(38,18) NOT NULL,
    "maxDrawdown" DECIMAL(18,8) NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "qualityFlags" TEXT[],
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authSubject_key" ON "User"("authSubject");

-- CreateIndex
CREATE INDEX "User_status_createdAt_idx" ON "User"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Agent_ownerId_status_idx" ON "Agent"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Agent_status_mode_idx" ON "Agent"("status", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_secretHash_key" ON "AgentCredential"("secretHash");

-- CreateIndex
CREATE INDEX "AgentCredential_agentId_revokedAt_idx" ON "AgentCredential"("agentId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_agentId_version_key" ON "StrategyVersion"("agentId", "version");

-- CreateIndex
CREATE INDEX "JournalEntry_agentId_publishedAt_idx" ON "JournalEntry"("agentId", "publishedAt");

-- CreateIndex
CREATE INDEX "JournalEntry_provenance_publishedAt_idx" ON "JournalEntry"("provenance", "publishedAt");

-- CreateIndex
CREATE INDEX "RiskPolicy_ownerId_active_idx" ON "RiskPolicy"("ownerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicy_ownerId_version_key" ON "RiskPolicy"("ownerId", "version");

-- CreateIndex
CREATE INDEX "TradeIntent_agentId_status_createdAt_idx" ON "TradeIntent"("agentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TradeIntent_venue_instrument_createdAt_idx" ON "TradeIntent"("venue", "instrument", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeIntent_agentId_idempotencyKey_key" ON "TradeIntent"("agentId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RiskDecision_intentId_key" ON "RiskDecision"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueOrder_intentId_key" ON "VenueOrder"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueOrder_clientOrderId_key" ON "VenueOrder"("clientOrderId");

-- CreateIndex
CREATE INDEX "VenueOrder_venue_state_updatedAt_idx" ON "VenueOrder"("venue", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "Fill_filledAt_idx" ON "Fill"("filledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_venueOrderId_fillRef_key" ON "Fill"("venueOrderId", "fillRef");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_occurredAt_idx" ON "AuditEvent"("targetType", "targetId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorType_actorId_occurredAt_idx" ON "AuditEvent"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_agentId_mode_windowEnd_idx" ON "PerformanceSnapshot"("agentId", "mode", "windowEnd");

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_provenance_windowEnd_idx" ON "PerformanceSnapshot"("provenance", "windowEnd");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeIntent" ADD CONSTRAINT "TradeIntent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskDecision" ADD CONSTRAINT "RiskDecision_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "TradeIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueOrder" ADD CONSTRAINT "VenueOrder_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "TradeIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_venueOrderId_fkey" FOREIGN KEY ("venueOrderId") REFERENCES "VenueOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
