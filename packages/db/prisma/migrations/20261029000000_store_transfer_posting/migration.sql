-- AlterEnum
ALTER TYPE "StoreTransferStatus" ADD VALUE 'PARTIALLY_RECEIVED';

-- AlterTable
ALTER TABLE "store_transfer_items" ADD COLUMN     "damagedQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "receivedQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
ADD COLUMN     "returnedQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "store_transfer_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "transferItemId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "quantityDelta" DECIMAL(18,6) NOT NULL,
    "valueDelta" DECIMAL(20,4) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "requestKey" VARCHAR(100) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_transfer_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_transfer_movements_tenantId_storeId_productId_effecti_idx" ON "store_transfer_movements"("tenantId", "storeId", "productId", "effectiveAt");

-- CreateIndex
CREATE INDEX "store_transfer_movements_tenantId_transferId_requestKey_idx" ON "store_transfer_movements"("tenantId", "transferId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "store_transfer_movements_tenantId_idempotencyKey_key" ON "store_transfer_movements"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movements_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "store_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movements_transferItemId_fkey" FOREIGN KEY ("transferItemId") REFERENCES "store_transfer_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movements_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Quantities and signed inventory effects are conserved even under unexpected callers.
ALTER TABLE "store_transfer_items" ADD CONSTRAINT "store_transfer_processed_quantities" CHECK ("receivedQuantity" >= 0 AND "returnedQuantity" >= 0 AND "damagedQuantity" >= 0 AND "receivedQuantity" + "returnedQuantity" + "damagedQuantity" <= "quantity");
ALTER TABLE "store_transfer_movements" ADD CONSTRAINT "store_transfer_movement_signs" CHECK ("quantity" > 0 AND "amount" >= 0 AND (("kind" = 'SHIP' AND "quantityDelta" = -"quantity" AND "valueDelta" = -"amount") OR ("kind" IN ('RECEIVE', 'RETURN') AND "quantityDelta" = "quantity" AND "valueDelta" = "amount") OR ("kind" = 'DAMAGE' AND "quantityDelta" = 0 AND "valueDelta" = 0)));

ALTER TABLE "store_transfers" ADD COLUMN "requestFingerprint" CHAR(64);
