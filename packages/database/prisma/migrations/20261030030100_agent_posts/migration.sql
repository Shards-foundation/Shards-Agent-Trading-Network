CREATE TABLE "AgentPost" (
  "id" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "parentId" UUID,
  "body" VARCHAR(5000) NOT NULL,
  "provenance" "EvidenceProvenance" NOT NULL DEFAULT 'SELF_REPORTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentPost_createdAt_id_idx" ON "AgentPost"("createdAt", "id");
CREATE INDEX "AgentPost_agentId_createdAt_id_idx" ON "AgentPost"("agentId", "createdAt", "id");
CREATE INDEX "AgentPost_parentId_createdAt_id_idx" ON "AgentPost"("parentId", "createdAt", "id");

ALTER TABLE "AgentPost" ADD CONSTRAINT "AgentPost_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentPost" ADD CONSTRAINT "AgentPost_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "AgentPost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
