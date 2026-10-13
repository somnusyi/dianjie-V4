-- AlterTable
ALTER TABLE "warehouse_inventory_policies" ADD COLUMN     "restoredLegacy" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "warehouse_inventory_policy_revisions" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "previousEffective" JSONB,
    "baseEffectiveVersion" INTEGER NOT NULL DEFAULT 0,
    "effectiveVersion" INTEGER,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_inventory_policy_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_inventory_policy_revision_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "revisionId" VARCHAR(64) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_inventory_policy_revision_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_revision_scope_key" ON "warehouse_inventory_policy_revisions"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "policy_revision_tenant_id_key" ON "warehouse_inventory_policy_revisions"("tenantId", "id");

-- CreateIndex
CREATE INDEX "policy_revision_event_history_idx" ON "warehouse_inventory_policy_revision_events"("tenantId", "revisionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "policy_revision_request_key" ON "warehouse_inventory_policy_revision_events"("tenantId", "requestId");

-- AddForeignKey
ALTER TABLE "warehouse_inventory_policy_revisions" ADD CONSTRAINT "warehouse_inventory_policy_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory_policy_revisions" ADD CONSTRAINT "warehouse_inventory_policy_revisions_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory_policy_revisions" ADD CONSTRAINT "warehouse_inventory_policy_revisions_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory_policy_revision_events" ADD CONSTRAINT "warehouse_inventory_policy_revision_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_inventory_policy_revision_events" ADD CONSTRAINT "warehouse_inventory_policy_revision_events_tenantId_revisi_fkey" FOREIGN KEY ("tenantId", "revisionId") REFERENCES "warehouse_inventory_policy_revisions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

