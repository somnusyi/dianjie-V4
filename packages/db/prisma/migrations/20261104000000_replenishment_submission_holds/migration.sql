-- CreateEnum
CREATE TYPE "ReplenishmentStockHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'TRANSFERRED');

-- AlterTable
ALTER TABLE "replenishment_orders" ADD COLUMN     "stockReservationPolicy" VARCHAR(40) NOT NULL DEFAULT 'LEGACY';

-- CreateTable
CREATE TABLE "replenishment_stock_holds" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "replenishmentOrderId" VARCHAR(64) NOT NULL,
    "replenishmentOrderItemId" VARCHAR(64) NOT NULL,
    "originalQuantity" DECIMAL(18,6) NOT NULL,
    "originalUnit" VARCHAR(16) NOT NULL,
    "conversionFactor" DECIMAL(18,6) NOT NULL,
    "inventoryQuantity" DECIMAL(18,6) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "status" "ReplenishmentStockHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "transferredAt" TIMESTAMP(3),
    "purchaseOrderId" TEXT,
    "purchaseOrderItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replenishment_stock_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "replenishment_stock_holds_replenishmentOrderItemId_key" ON "replenishment_stock_holds"("replenishmentOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "replenishment_stock_holds_purchaseOrderItemId_key" ON "replenishment_stock_holds"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "replenishment_stock_holds_tenantId_warehouseId_productId_st_idx" ON "replenishment_stock_holds"("tenantId", "warehouseId", "productId", "status");

-- CreateIndex
CREATE INDEX "replenishment_stock_holds_tenantId_replenishmentOrderId_sta_idx" ON "replenishment_stock_holds"("tenantId", "replenishmentOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_purchaseOrderId_id_key" ON "purchase_order_items"("purchaseOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "replenishment_order_items_tenantId_replenishmentOrderId_id_key" ON "replenishment_order_items"("tenantId", "replenishmentOrderId", "id");

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_replenishmentOrderId_fkey" FOREIGN KEY ("tenantId", "replenishmentOrderId") REFERENCES "replenishment_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_replenishmentOrderId_re_fkey" FOREIGN KEY ("tenantId", "replenishmentOrderId", "replenishmentOrderItemId") REFERENCES "replenishment_order_items"("tenantId", "replenishmentOrderId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_stock_holds_purchaseOrderId_purchaseOrderIte_fkey" FOREIGN KEY ("purchaseOrderId", "purchaseOrderItemId") REFERENCES "purchase_order_items"("purchaseOrderId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- No historical data is imported or backfilled. Existing requests remain LEGACY.
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_hold_positive_frozen_quantity" CHECK ("originalQuantity" > 0 AND "conversionFactor" > 0 AND "inventoryQuantity" > 0 AND "inventoryQuantity" = ROUND("originalQuantity" * "conversionFactor", 6));
ALTER TABLE "replenishment_stock_holds" ADD CONSTRAINT "replenishment_hold_state_ownership" CHECK (
 ("status" = 'ACTIVE' AND "releasedAt" IS NULL AND "transferredAt" IS NULL AND "purchaseOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
 ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "transferredAt" IS NULL AND "purchaseOrderId" IS NULL AND "purchaseOrderItemId" IS NULL) OR
 ("status" = 'TRANSFERRED' AND "releasedAt" IS NULL AND "transferredAt" IS NOT NULL AND "purchaseOrderId" IS NOT NULL AND "purchaseOrderItemId" IS NOT NULL)
);
