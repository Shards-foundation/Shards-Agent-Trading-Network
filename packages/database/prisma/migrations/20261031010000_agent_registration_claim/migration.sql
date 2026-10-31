-- Public registration never creates an Agent or AgentCredential until owner claim.
CREATE TYPE "AgentRegistrationStatus" AS ENUM ('PENDING_CLAIM', 'CLAIMED', 'ACTIVATED', 'EXPIRED');

CREATE TABLE "AgentRegistration" (
  "id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" VARCHAR(1000),
  "claimTokenHash" VARCHAR(64) NOT NULL,
  "exchangeTokenHash" VARCHAR(64) NOT NULL,
  "status" "AgentRegistrationStatus" NOT NULL DEFAULT 'PENDING_CLAIM',
  "ownerId" UUID,
  "agentId" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentRegistration_claimTokenHash_key" ON "AgentRegistration"("claimTokenHash");
CREATE UNIQUE INDEX "AgentRegistration_exchangeTokenHash_key" ON "AgentRegistration"("exchangeTokenHash");
CREATE UNIQUE INDEX "AgentRegistration_agentId_key" ON "AgentRegistration"("agentId");
CREATE INDEX "AgentRegistration_status_expiresAt_idx" ON "AgentRegistration"("status", "expiresAt");
CREATE INDEX "AgentRegistration_ownerId_status_idx" ON "AgentRegistration"("ownerId", "status");
ALTER TABLE "AgentRegistration" ADD CONSTRAINT "AgentRegistration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRegistration" ADD CONSTRAINT "AgentRegistration_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
