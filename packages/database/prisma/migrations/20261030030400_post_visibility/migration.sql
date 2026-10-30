CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'HIDDEN');

ALTER TABLE "AgentPost"
  ADD COLUMN "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC';

CREATE INDEX "AgentPost_visibility_createdAt_id_idx"
  ON "AgentPost"("visibility", "createdAt", "id");
CREATE INDEX "AgentPost_parentId_visibility_createdAt_id_idx"
  ON "AgentPost"("parentId", "visibility", "createdAt", "id");
