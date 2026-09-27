-- CreateTable
CREATE TABLE "warehouse_stocktakes" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "countDate" DATE NOT NULL,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'DRAFT',
    "note" VARCHAR(240),
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "confirmedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stocktake_partitions" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stocktakeId" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "savedById" TEXT,
    "savedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_stocktake_partitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stocktake_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stocktakeId" VARCHAR(64) NOT NULL,
    "partitionId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "bookQuantity" DECIMAL(18,6) NOT NULL,
    "bookValue" DECIMAL(20,4) NOT NULL,
    "bookVersion" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "countedQuantity" DECIMAL(18,6),
    "countedValue" DECIMAL(20,4),
    "differenceQuantity" DECIMAL(18,6),
    "differenceAmount" DECIMAL(20,4),
    "reason" VARCHAR(240),
    "movementId" VARCHAR(64),

    CONSTRAINT "warehouse_stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stocktake_adjustments" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stocktakeId" VARCHAR(64) NOT NULL,
    "no" VARCHAR(90) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stocktake_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_stocktakes_tenantId_countDate_idx" ON "warehouse_stocktakes"("tenantId", "countDate");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_id_key" ON "warehouse_stocktakes"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_no_key" ON "warehouse_stocktakes"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_partitions_tenantId_id_key" ON "warehouse_stocktake_partitions"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_partitions_tenantId_stocktakeId_name_key" ON "warehouse_stocktake_partitions"("tenantId", "stocktakeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_lines_movementId_key" ON "warehouse_stocktake_lines"("movementId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_lines_tenantId_stocktakeId_productId_key" ON "warehouse_stocktake_lines"("tenantId", "stocktakeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_tenantId_stocktakeId_kind_key" ON "warehouse_stocktake_adjustments"("tenantId", "stocktakeId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_tenantId_no_key" ON "warehouse_stocktake_adjustments"("tenantId", "no");

-- AddForeignKey
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_partitions" ADD CONSTRAINT "warehouse_stocktake_partitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_partitions" ADD CONSTRAINT "warehouse_stocktake_partitions_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_partitionId_fkey" FOREIGN KEY ("tenantId", "partitionId") REFERENCES "warehouse_stocktake_partitions"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_adjustments" ADD CONSTRAINT "warehouse_stocktake_adjustments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_adjustments" ADD CONSTRAINT "warehouse_stocktake_adjustments_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

