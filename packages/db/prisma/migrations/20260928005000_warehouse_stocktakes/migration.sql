-- 总仓供应链盘点：独立于门店盘点，支持分区/多人录入、汇总审核和盘盈盘亏单据。
CREATE TYPE "WarehouseStocktakeStatus" AS ENUM ('DRAFT', 'COUNTING', 'REVIEWING', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "WarehouseStocktakeSectionStatus" AS ENUM ('OPEN', 'SUBMITTED');
CREATE TYPE "WarehouseStocktakeAdjustmentType" AS ENUM ('PROFIT', 'LOSS');

CREATE TABLE "warehouse_stocktakes" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "warehouseId" VARCHAR(64) NOT NULL,
  "no" VARCHAR(40) NOT NULL,
  "countDate" DATE NOT NULL,
  "status" "WarehouseStocktakeStatus" NOT NULL DEFAULT 'DRAFT',
  "rowVersion" INTEGER NOT NULL DEFAULT 0,
  "itemCount" INTEGER NOT NULL DEFAULT 0,
  "countedCount" INTEGER NOT NULL DEFAULT 0,
  "differenceCount" INTEGER NOT NULL DEFAULT 0,
  "totalBookValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "totalCountedValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "totalDifferenceValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "note" VARCHAR(500),
  "reviewNote" VARCHAR(500),
  "requestKey" VARCHAR(160) NOT NULL,
  "createdById" TEXT NOT NULL,
  "submittedById" TEXT,
  "reviewedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktakes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_stocktake_sections" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "assignedToId" TEXT NOT NULL,
  "status" "WarehouseStocktakeSectionStatus" NOT NULL DEFAULT 'OPEN',
  "rowVersion" INTEGER NOT NULL DEFAULT 0,
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_sections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_stocktake_items" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "sectionId" VARCHAR(64) NOT NULL,
  "productId" TEXT NOT NULL,
  "productCodeSnapshot" VARCHAR(80) NOT NULL,
  "productNameSnapshot" VARCHAR(160) NOT NULL,
  "productSpecSnapshot" VARCHAR(240),
  "categorySnapshot" VARCHAR(120),
  "inventoryUnit" VARCHAR(16) NOT NULL,
  "bookQuantity" DECIMAL(18,6) NOT NULL,
  "bookValue" DECIMAL(20,4) NOT NULL,
  "averageUnitCost" DECIMAL(18,6) NOT NULL,
  "bookBalanceVersion" INTEGER NOT NULL,
  "countedUnitCost" DECIMAL(18,6),
  "countedQuantity" DECIMAL(18,6),
  "countedValue" DECIMAL(20,4),
  "differenceQuantity" DECIMAL(18,6),
  "differenceValue" DECIMAL(20,4),
  "reason" VARCHAR(240),
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_stocktake_entries" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "sectionId" VARCHAR(64) NOT NULL,
  "stocktakeItemId" VARCHAR(64) NOT NULL,
  "enteredById" TEXT NOT NULL,
  "countedQuantity" DECIMAL(18,6) NOT NULL,
  "countedUnitCost" DECIMAL(18,6) NOT NULL,
  "note" VARCHAR(240),
  "rowVersion" INTEGER NOT NULL DEFAULT 0,
  "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_stocktake_adjustments" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "no" VARCHAR(40) NOT NULL,
  "type" "WarehouseStocktakeAdjustmentType" NOT NULL,
  "itemCount" INTEGER NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_stocktake_adjustment_lines" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adjustmentId" VARCHAR(64) NOT NULL,
  "stocktakeItemId" VARCHAR(64) NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "inventoryUnit" VARCHAR(16) NOT NULL,
  "unitCost" DECIMAL(18,6) NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL,
  "movementId" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_adjustment_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_no_key" ON "warehouse_stocktakes"("tenantId", "no");
CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_id_key" ON "warehouse_stocktakes"("tenantId", "id");
CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_requestKey_key" ON "warehouse_stocktakes"("tenantId", "requestKey");
CREATE INDEX "wst_tenant_warehouse_status_date_idx" ON "warehouse_stocktakes"("tenantId", "warehouseId", "status", "countDate");
CREATE UNIQUE INDEX "wst_one_active_per_warehouse_key" ON "warehouse_stocktakes"("tenantId", "warehouseId") WHERE "status" IN ('DRAFT', 'COUNTING', 'REVIEWING');
CREATE UNIQUE INDEX "warehouse_stocktake_sections_stocktakeId_name_key" ON "warehouse_stocktake_sections"("stocktakeId", "name");
CREATE UNIQUE INDEX "warehouse_stocktake_sections_tenantId_id_key" ON "warehouse_stocktake_sections"("tenantId", "id");
CREATE UNIQUE INDEX "wsts_tenant_stocktake_id_key" ON "warehouse_stocktake_sections"("tenantId", "stocktakeId", "id");
CREATE INDEX "wsts_tenant_assignee_status_idx" ON "warehouse_stocktake_sections"("tenantId", "assignedToId", "status");
CREATE UNIQUE INDEX "warehouse_stocktake_items_stocktakeId_productId_key" ON "warehouse_stocktake_items"("stocktakeId", "productId");
CREATE UNIQUE INDEX "warehouse_stocktake_items_tenantId_id_key" ON "warehouse_stocktake_items"("tenantId", "id");
CREATE UNIQUE INDEX "wsti_tenant_stocktake_id_key" ON "warehouse_stocktake_items"("tenantId", "stocktakeId", "id");
CREATE INDEX "wsti_section_sort_idx" ON "warehouse_stocktake_items"("sectionId", "sortOrder");
CREATE INDEX "wsti_tenant_product_idx" ON "warehouse_stocktake_items"("tenantId", "productId");
CREATE UNIQUE INDEX "warehouse_stocktake_entries_stocktakeItemId_key" ON "warehouse_stocktake_entries"("stocktakeItemId");
CREATE UNIQUE INDEX "warehouse_stocktake_entries_tenantId_stocktakeItemId_key" ON "warehouse_stocktake_entries"("tenantId", "stocktakeItemId");
CREATE UNIQUE INDEX "wste_tenant_stocktake_item_key" ON "warehouse_stocktake_entries"("tenantId", "stocktakeId", "stocktakeItemId");
CREATE INDEX "wste_tenant_actor_saved_idx" ON "warehouse_stocktake_entries"("tenantId", "enteredById", "savedAt");
CREATE INDEX "wste_stocktake_section_idx" ON "warehouse_stocktake_entries"("stocktakeId", "sectionId");
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_tenantId_no_key" ON "warehouse_stocktake_adjustments"("tenantId", "no");
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_tenantId_id_key" ON "warehouse_stocktake_adjustments"("tenantId", "id");
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_stocktakeId_type_key" ON "warehouse_stocktake_adjustments"("stocktakeId", "type");
CREATE INDEX "warehouse_stocktake_adjustments_tenantId_type_createdAt_idx" ON "warehouse_stocktake_adjustments"("tenantId", "type", "createdAt");
CREATE UNIQUE INDEX "wstal_adjustment_item_key" ON "warehouse_stocktake_adjustment_lines"("adjustmentId", "stocktakeItemId");
CREATE UNIQUE INDEX "wstal_movement_key" ON "warehouse_stocktake_adjustment_lines"("movementId");
CREATE INDEX "wstal_tenant_product_idx" ON "warehouse_stocktake_adjustment_lines"("tenantId", "productId");
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");

ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "wst_created_actor_fk" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "wst_submitted_actor_fk" FOREIGN KEY ("tenantId", "submittedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "wst_reviewed_actor_fk" FOREIGN KEY ("tenantId", "reviewedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_sections" ADD CONSTRAINT "warehouse_stocktake_sections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_sections" ADD CONSTRAINT "warehouse_stocktake_sections_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_sections" ADD CONSTRAINT "wsts_assignee_fk" FOREIGN KEY ("tenantId", "assignedToId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_items" ADD CONSTRAINT "warehouse_stocktake_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_items" ADD CONSTRAINT "warehouse_stocktake_items_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_items" ADD CONSTRAINT "wsti_section_fk" FOREIGN KEY ("tenantId", "stocktakeId", "sectionId") REFERENCES "warehouse_stocktake_sections"("tenantId", "stocktakeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_items" ADD CONSTRAINT "warehouse_stocktake_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_entries" ADD CONSTRAINT "warehouse_stocktake_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_entries" ADD CONSTRAINT "warehouse_stocktake_entries_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_entries" ADD CONSTRAINT "wste_section_fk" FOREIGN KEY ("tenantId", "stocktakeId", "sectionId") REFERENCES "warehouse_stocktake_sections"("tenantId", "stocktakeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_entries" ADD CONSTRAINT "wste_item_fk" FOREIGN KEY ("tenantId", "stocktakeId", "stocktakeItemId") REFERENCES "warehouse_stocktake_items"("tenantId", "stocktakeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_entries" ADD CONSTRAINT "wste_actor_fk" FOREIGN KEY ("tenantId", "enteredById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustments" ADD CONSTRAINT "warehouse_stocktake_adjustments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustments" ADD CONSTRAINT "warehouse_stocktake_adjustments_tenantId_stocktakeId_fkey" FOREIGN KEY ("tenantId", "stocktakeId") REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustment_lines" ADD CONSTRAINT "warehouse_stocktake_adjustment_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustment_lines" ADD CONSTRAINT "warehouse_stocktake_adjustment_lines_tenantId_adjustmentId_fkey" FOREIGN KEY ("tenantId", "adjustmentId") REFERENCES "warehouse_stocktake_adjustments"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustment_lines" ADD CONSTRAINT "warehouse_stocktake_adjustment_lines_tenantId_stocktakeItemId_fkey" FOREIGN KEY ("tenantId", "stocktakeItemId") REFERENCES "warehouse_stocktake_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustment_lines" ADD CONSTRAINT "warehouse_stocktake_adjustment_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_stocktake_adjustment_lines" ADD CONSTRAINT "wstal_movement_fk" FOREIGN KEY ("movementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
