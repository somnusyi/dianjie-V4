-- PostgreSQL migration draft: keep all DDL in this file atomic.
BEGIN;

-- DropIndex
DROP INDEX "warehouse_ledger_lots_tenantId_warehouseId_productId_batchN_key";

-- AlterTable
ALTER TABLE "warehouse_ledger_lots" ADD COLUMN     "batchRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "replacesLotId" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_lot_batch_revision_key" ON "warehouse_ledger_lots"("tenantId", "warehouseId", "productId", "batchNo", "batchRevision");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_lot_tenant_id_key" ON "warehouse_ledger_lots"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_lot_revision_successor_key" ON "warehouse_ledger_lots"("tenantId", "replacesLotId");

-- AddForeignKey
ALTER TABLE "warehouse_ledger_lots" ADD CONSTRAINT "warehouse_lot_revision_parent_fkey" FOREIGN KEY ("tenantId", "replacesLotId") REFERENCES "warehouse_ledger_lots"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_ledger_lots" ADD CONSTRAINT "warehouse_lot_revision_shape_check" CHECK (("batchRevision" = 1 AND "replacesLotId" IS NULL) OR ("batchRevision" > 1 AND "replacesLotId" IS NOT NULL));

COMMIT;
