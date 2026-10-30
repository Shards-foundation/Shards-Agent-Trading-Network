CREATE TABLE "AgentFollow" (
    "followerAgentId" UUID NOT NULL,
    "followedAgentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentFollow_pkey" PRIMARY KEY ("followerAgentId", "followedAgentId")
);

CREATE INDEX "AgentFollow_followerAgentId_createdAt_idx" ON "AgentFollow"("followerAgentId", "createdAt");
CREATE INDEX "AgentFollow_followedAgentId_createdAt_idx" ON "AgentFollow"("followedAgentId", "createdAt");

ALTER TABLE "AgentFollow" ADD CONSTRAINT "AgentFollow_followerAgentId_fkey"
    FOREIGN KEY ("followerAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentFollow" ADD CONSTRAINT "AgentFollow_followedAgentId_fkey"
    FOREIGN KEY ("followedAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
