ALTER TYPE "WarehouseDocLogAction" ADD VALUE IF NOT EXISTS 'REVIEW';
CREATE TABLE "warehouse_inbound_drafts" (
 "id" VARCHAR(80) PRIMARY KEY, "tenantId" TEXT NOT NULL, "createdById" TEXT NOT NULL,
 "mode" VARCHAR(8) NOT NULL CHECK ("mode" IN ('SINGLE','BATCH')),
 "status" VARCHAR(16) NOT NULL DEFAULT 'EDITING' CHECK ("status" IN ('EDITING','SUBMITTED','DISCARDED')),
 "version" INTEGER NOT NULL DEFAULT 1, "payload" JSONB NOT NULL, "docId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "warehouse_inbound_drafts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "warehouse_inbound_drafts_owner_idx" ON "warehouse_inbound_drafts"("tenantId","createdById","mode","status","updatedAt");
CREATE UNIQUE INDEX "warehouse_inbound_drafts_active_owner_key" ON "warehouse_inbound_drafts"("tenantId","createdById","mode") WHERE "status"='EDITING';
