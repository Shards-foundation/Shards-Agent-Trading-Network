CREATE TABLE "AgentFollow" (
    "id" UUID NOT NULL,
    "followerAgentId" UUID NOT NULL,
    "followingAgentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentFollow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentFollow_followerAgentId_followingAgentId_key" ON "AgentFollow"("followerAgentId", "followingAgentId");
CREATE INDEX "AgentFollow_followingAgentId_createdAt_idx" ON "AgentFollow"("followingAgentId", "createdAt");
CREATE INDEX "AgentFollow_followerAgentId_createdAt_idx" ON "AgentFollow"("followerAgentId", "createdAt");
ALTER TABLE "AgentFollow" ADD CONSTRAINT "AgentFollow_followerAgentId_fkey" FOREIGN KEY ("followerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentFollow" ADD CONSTRAINT "AgentFollow_followingAgentId_fkey" FOREIGN KEY ("followingAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentFollow" ADD CONSTRAINT "AgentFollow_no_self_follow" CHECK ("followerAgentId" <> "followingAgentId");
