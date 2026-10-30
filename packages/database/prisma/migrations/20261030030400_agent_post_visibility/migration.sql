ALTER TABLE "AgentPost"
  ADD COLUMN "hiddenAt" TIMESTAMP(3),
  ADD COLUMN "hiddenByUserId" UUID;

CREATE INDEX "AgentPost_hiddenAt_createdAt_id_idx"
  ON "AgentPost"("hiddenAt", "createdAt", "id");

ALTER TABLE "AgentPost"
  ADD CONSTRAINT "AgentPost_hiddenByUserId_fkey"
  FOREIGN KEY ("hiddenByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
