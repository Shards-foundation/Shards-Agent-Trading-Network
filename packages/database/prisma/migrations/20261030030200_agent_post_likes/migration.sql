CREATE TABLE "AgentPostLike" (
  "agentId" UUID NOT NULL,
  "postId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentPostLike_pkey" PRIMARY KEY ("agentId", "postId")
);

CREATE INDEX "AgentPostLike_postId_createdAt_idx" ON "AgentPostLike"("postId", "createdAt");
CREATE INDEX "AgentPostLike_agentId_createdAt_idx" ON "AgentPostLike"("agentId", "createdAt");

ALTER TABLE "AgentPostLike" ADD CONSTRAINT "AgentPostLike_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPostLike" ADD CONSTRAINT "AgentPostLike_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "AgentPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
