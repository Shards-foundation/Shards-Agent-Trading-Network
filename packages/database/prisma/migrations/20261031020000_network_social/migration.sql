-- Production social tables; append-only migration, preserving legacy agent posts.
CREATE TABLE "NetworkCommunity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" VARCHAR(40) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(600) NOT NULL,
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NetworkCommunity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NetworkCommunity_slug_key" ON "NetworkCommunity"("slug");
CREATE INDEX "NetworkCommunity_status_createdAt_idx" ON "NetworkCommunity"("status", "createdAt");
ALTER TABLE "NetworkCommunity" ADD CONSTRAINT "NetworkCommunity_createdById_fkey"
 FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentPost" ADD COLUMN "communityId" UUID;
ALTER TABLE "AgentPost" ADD CONSTRAINT "AgentPost_communityId_fkey"
 FOREIGN KEY ("communityId") REFERENCES "NetworkCommunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AgentPost_communityId_createdAt_id_idx" ON "AgentPost"("communityId", "createdAt", "id");
CREATE TABLE "NetworkVote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "postId" UUID NOT NULL,
  "actorType" VARCHAR(10) NOT NULL,
  "actorId" UUID NOT NULL,
  "value" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NetworkVote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NetworkVote_value_check" CHECK ("value" IN (-1,1)),
  CONSTRAINT "NetworkVote_actorType_check" CHECK ("actorType" IN ('HUMAN','SHARD'))
);
CREATE UNIQUE INDEX "NetworkVote_postId_actorType_actorId_key" ON "NetworkVote"("postId","actorType","actorId");
CREATE INDEX "NetworkVote_postId_value_idx" ON "NetworkVote"("postId","value");
ALTER TABLE "NetworkVote" ADD CONSTRAINT "NetworkVote_postId_fkey" FOREIGN KEY ("postId") REFERENCES "AgentPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "NetworkComment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "postId" UUID NOT NULL,
  "actorType" VARCHAR(10) NOT NULL,
  "actorId" UUID NOT NULL,
  "body" VARCHAR(2000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NetworkComment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NetworkComment_actorType_check" CHECK ("actorType" IN ('HUMAN','SHARD'))
);
CREATE INDEX "NetworkComment_postId_createdAt_idx" ON "NetworkComment"("postId","createdAt");
ALTER TABLE "NetworkComment" ADD CONSTRAINT "NetworkComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "AgentPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "NetworkSubscription" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "communityId" UUID NOT NULL,
  "actorType" VARCHAR(10) NOT NULL,
  "actorId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NetworkSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NetworkSubscription_actorType_check" CHECK ("actorType" IN ('HUMAN','SHARD'))
);
CREATE UNIQUE INDEX "NetworkSubscription_communityId_actorType_actorId_key" ON "NetworkSubscription"("communityId","actorType","actorId");
CREATE INDEX "NetworkSubscription_communityId_createdAt_idx" ON "NetworkSubscription"("communityId","createdAt");
ALTER TABLE "NetworkSubscription" ADD CONSTRAINT "NetworkSubscription_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "NetworkCommunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "NetworkCommunity" ("slug","name","description") VALUES
 ('general','General','Introductions, announcements and cross-market discussions.'),
 ('market-analysis','Market Analysis','Research, market structures, liquidity and price action.'),
 ('strategy-lab','Strategy Lab','Experiments, backtests, trade hypotheses and verified results.'),
 ('defi','DeFi & Onchain','Protocols, liquidity pools, onchain execution and risk.'),
 ('risk-and-security','Risk & Security','Safety controls, custody, vulnerabilities and incident analysis.');
