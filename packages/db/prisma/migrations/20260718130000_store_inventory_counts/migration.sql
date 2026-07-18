CREATE TYPE "InventoryCountStatus" AS ENUM ('DRAFT', 'COUNTING', 'REVIEWING', 'CONFIRMED', 'CANCELLED', 'REVERSED');

CREATE TABLE "inventory_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "countDate" DATE NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'DRAFT',
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "snapshotId" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "countedCount" INTEGER NOT NULL DEFAULT 0,
    "differenceCount" INTEGER NOT NULL DEFAULT 0,
    "totalBookValue" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "totalCountedValue" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "totalDifferenceValue" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "note" TEXT,
    "reversalReason" TEXT,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "confirmedById" TEXT,
    "reversedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_counts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_count_items" (
    "id" TEXT NOT NULL,
    "inventoryCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productCodeSnapshot" TEXT NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "productSpecSnapshot" TEXT,
    "categorySnapshot" TEXT,
    "unitSnapshot" TEXT NOT NULL,
    "bookQuantity" DECIMAL(14,6) NOT NULL,
    "countedQuantity" DECIMAL(14,6),
    "averageUnitCost" DECIMAL(14,4) NOT NULL,
    "differenceQuantity" DECIMAL(14,6),
    "differenceAmount" DECIMAL(14,3),
    "reasonCode" VARCHAR(40),
    "reasonNote" TEXT,
    "evidenceKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_count_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_counts_tenantId_no_key" ON "inventory_counts"("tenantId", "no");
CREATE UNIQUE INDEX "inventory_counts_storeId_countDate_revision_key" ON "inventory_counts"("storeId", "countDate", "revision");
CREATE UNIQUE INDEX "inventory_counts_snapshotId_key" ON "inventory_counts"("snapshotId");
CREATE INDEX "inventory_counts_tenantId_storeId_status_countDate_idx" ON "inventory_counts"("tenantId", "storeId", "status", "countDate");
CREATE UNIQUE INDEX "inventory_counts_one_active_per_store_idx"
    ON "inventory_counts"("storeId")
    WHERE "status" IN ('DRAFT', 'COUNTING', 'REVIEWING');

CREATE UNIQUE INDEX "inventory_count_items_inventoryCountId_productId_key" ON "inventory_count_items"("inventoryCountId", "productId");
CREATE INDEX "inventory_count_items_inventoryCountId_sortOrder_idx" ON "inventory_count_items"("inventoryCountId", "sortOrder");
CREATE INDEX "inventory_count_items_productId_idx" ON "inventory_count_items"("productId");

ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_inventoryCountId_fkey" FOREIGN KEY ("inventoryCountId") REFERENCES "inventory_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_count_items" ADD CONSTRAINT "inventory_count_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
