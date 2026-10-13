-- DropIndex
DROP INDEX "policy_revision_scope_key";

-- AlterTable
ALTER TABLE "warehouse_inventory_policy_revisions" ADD COLUMN     "cycleNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "isCurrent" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "rowVersion" SET DEFAULT 1;

-- CreateIndex
CREATE INDEX "policy_revision_current_idx" ON "warehouse_inventory_policy_revisions"("tenantId", "warehouseId", "productId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "policy_revision_cycle_key" ON "warehouse_inventory_policy_revisions"("tenantId", "warehouseId", "productId", "cycleNumber");


CREATE UNIQUE INDEX "policy_revision_one_current_key" ON "warehouse_inventory_policy_revisions"("tenantId","warehouseId","productId") WHERE "isCurrent" = true;
