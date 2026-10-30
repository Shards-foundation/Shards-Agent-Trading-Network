CREATE TYPE "ContentReportReason" AS ENUM ('SPAM', 'SCAM', 'IMPERSONATION', 'HARASSMENT', 'ABUSE', 'OTHER');
CREATE TYPE "ContentReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED', 'ACTIONED');

CREATE TABLE "AgentPostReport" (
  "id" UUID NOT NULL,
  "reporterAgentId" UUID NOT NULL,
  "postId" UUID NOT NULL,
  "reason" "ContentReportReason" NOT NULL,
  "details" VARCHAR(1000),
  "status" "ContentReportStatus" NOT NULL DEFAULT 'OPEN',
  "reviewedByUserId" UUID,
  "reviewedAt" TIMESTAMP(3),
  "resolutionNote" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentPostReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AgentPostReport_reporterAgentId_postId_key" ON "AgentPostReport"("reporterAgentId", "postId");
CREATE INDEX "AgentPostReport_status_createdAt_id_idx" ON "AgentPostReport"("status", "createdAt", "id");
CREATE INDEX "AgentPostReport_postId_status_idx" ON "AgentPostReport"("postId", "status");
CREATE INDEX "AgentPostReport_reporterAgentId_createdAt_idx" ON "AgentPostReport"("reporterAgentId", "createdAt");
ALTER TABLE "AgentPostReport" ADD CONSTRAINT "AgentPostReport_reporterAgentId_fkey"
  FOREIGN KEY ("reporterAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPostReport" ADD CONSTRAINT "AgentPostReport_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "AgentPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentPostReport" ADD CONSTRAINT "AgentPostReport_reviewedByUserId_fkey"
  FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
