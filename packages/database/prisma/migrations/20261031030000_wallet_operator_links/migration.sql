-- Additive release only: no existing trade, agent, or social records are modified.
CREATE TYPE "WalletChain" AS ENUM ('SOLANA', 'EVM');
CREATE TABLE "WalletChallenge" (
  "id" UUID PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "chain" "WalletChain" NOT NULL,
  "address" VARCHAR(128) NOT NULL,
  "message" VARCHAR(2000) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WalletChallenge_ownerId_expiresAt_idx" ON "WalletChallenge"("ownerId", "expiresAt");
CREATE TABLE "VerifiedWallet" (
  "id" UUID PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "chain" "WalletChain" NOT NULL,
  "address" VARCHAR(128) NOT NULL,
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerifiedWallet_chain_address_key" UNIQUE ("chain", "address")
);
CREATE INDEX "VerifiedWallet_ownerId_status_idx" ON "VerifiedWallet"("ownerId", "status");
CREATE TABLE "AgentWalletLink" (
  "id" UUID PRIMARY KEY,
  "walletId" UUID NOT NULL REFERENCES "VerifiedWallet"("id") ON DELETE RESTRICT,
  "agentId" UUID NOT NULL REFERENCES "Agent"("id") ON DELETE RESTRICT,
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "tradeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentWalletLink_walletId_agentId_key" UNIQUE ("walletId", "agentId")
);
CREATE INDEX "AgentWalletLink_agentId_status_idx" ON "AgentWalletLink"("agentId", "status");
