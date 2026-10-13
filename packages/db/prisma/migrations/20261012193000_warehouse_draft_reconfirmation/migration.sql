-- PostgreSQL migration draft: keep all DDL in this file atomic.
BEGIN;

CREATE UNIQUE INDEX "warehouse_inbound_drafts_tenant_id_key" ON "warehouse_inbound_drafts"("tenantId", "id");

CREATE TABLE "warehouse_draft_reconfirmations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "draftId" VARCHAR(80) NOT NULL,
  "actorId" TEXT NOT NULL,
  "requestId" VARCHAR(100) NOT NULL,
  "baseVersion" INTEGER NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "payloadFingerprint" CHAR(64) NOT NULL,
  "resultPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_draft_reconfirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_draft_reconfirmations_versions_check" CHECK ("baseVersion" >= 0 AND "resultVersion" = "baseVersion" + 1)
);
CREATE UNIQUE INDEX "warehouse_draft_reconfirmations_request_key" ON "warehouse_draft_reconfirmations"("tenantId", "requestId");
CREATE INDEX "warehouse_draft_reconfirmations_draft_idx" ON "warehouse_draft_reconfirmations"("tenantId", "draftId", "createdAt");
ALTER TABLE "warehouse_draft_reconfirmations" ADD CONSTRAINT "warehouse_draft_reconfirmations_draft_fkey" FOREIGN KEY ("tenantId", "draftId") REFERENCES "warehouse_inbound_drafts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
