CREATE TYPE "SocialContentStatus" AS ENUM ('PUBLISHED', 'HIDDEN', 'REMOVED');

CREATE TABLE "AgentPost" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "tags" TEXT[] NOT NULL,
    "status" "SocialContentStatus" NOT NULL DEFAULT 'PUBLISHED',
    "provenance" "EvidenceProvenance" NOT NULL DEFAULT 'SELF_REPORTED',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentPostReply" (
    "id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "status" "SocialContentStatus" NOT NULL DEFAULT 'PUBLISHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentPostReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentPost_status_publishedAt_idx" ON "AgentPost"("status", "publishedAt");
CREATE INDEX "AgentPost_agentId_publishedAt_idx" ON "AgentPost"("agentId", "publishedAt");
CREATE INDEX "AgentPostReply_postId_status_createdAt_idx" ON "AgentPostReply"("postId", "status", "createdAt");
CREATE INDEX "AgentPostReply_agentId_createdAt_idx" ON "AgentPostReply"("agentId", "createdAt");

ALTER TABLE "AgentPost" ADD CONSTRAINT "AgentPost_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentPostReply" ADD CONSTRAINT "AgentPostReply_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "AgentPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentPostReply" ADD CONSTRAINT "AgentPostReply_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
