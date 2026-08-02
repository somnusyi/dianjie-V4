-- Meituan warehouse inventory snapshot import foundation.
--
-- A snapshot import is an auditable warehouse document, not a purchase
-- inbound. Confirmation writes only the delta needed to reach the source
-- closing balance; reversal appends the opposite movement.

CREATE TYPE "WarehouseInventoryImportSource" AS ENUM ('MEITUAN');
CREATE TYPE "WarehouseInventoryImportStatus" AS ENUM ('STAGED', 'CONFIRMED', 'REVERSED');

CREATE TABLE "product_external_codes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" "WarehouseInventoryImportSource" NOT NULL,
    "externalCode" VARCHAR(80) NOT NULL,
    "externalName" VARCHAR(120),
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_external_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_inventory_imports" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "no" VARCHAR(50) NOT NULL,
    "source" "WarehouseInventoryImportSource" NOT NULL,
    "sourceFilename" VARCHAR(255) NOT NULL,
    "fileHash" CHAR(64) NOT NULL,
    "sourceWarehouseName" VARCHAR(100) NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "status" "WarehouseInventoryImportStatus" NOT NULL DEFAULT 'STAGED',
    "sourceRowCount" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "ignoredRowCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "blockingCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "detailTotalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sourceTotalAmount" DECIMAL(14,2),
    "metadata" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "reversedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversalReason" VARCHAR(240),
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_inventory_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_inventory_import_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "externalCode" VARCHAR(80) NOT NULL,
    "externalName" VARCHAR(120) NOT NULL,
    "sourceSpec" VARCHAR(160),
    "sourceCategory" VARCHAR(80),
    "sourceWarehouseName" VARCHAR(100) NOT NULL,
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "conversionText" VARCHAR(80),
    "sourceQuantity" DECIMAL(18,6) NOT NULL,
    "inventoryAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inventoryAmountExcludingTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "inventoryTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "averageCostExcludingTax" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "expectedInboundQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "expectedOutboundQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "theoreticalQuantity" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "theoreticalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "productId" TEXT,
    "matchSource" VARCHAR(40),
    "inventoryUnit" VARCHAR(16),
    "conversionFactor" DECIMAL(18,6),
    "normalizedQuantity" DECIMAL(12,3),
    "issues" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "rawData" JSONB NOT NULL,
    "oldQuantity" DECIMAL(12,3),
    "delta" DECIMAL(12,3),
    "movementId" TEXT,
    "reversalMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_inventory_import_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_external_codes_tenantId_source_externalCode_key"
ON "product_external_codes"("tenantId", "source", "externalCode");
CREATE INDEX "product_external_codes_tenantId_productId_source_idx"
ON "product_external_codes"("tenantId", "productId", "source");

CREATE UNIQUE INDEX "warehouse_inventory_imports_tenantId_id_key"
ON "warehouse_inventory_imports"("tenantId", "id");
CREATE UNIQUE INDEX "warehouse_inventory_imports_tenantId_no_key"
ON "warehouse_inventory_imports"("tenantId", "no");
CREATE UNIQUE INDEX "warehouse_inventory_imports_idempotency_key"
ON "warehouse_inventory_imports"("tenantId", "warehouseId", "source", "fileHash");
CREATE INDEX "warehouse_inventory_imports_scope_date_status_idx"
ON "warehouse_inventory_imports"("tenantId", "warehouseId", "snapshotDate", "status");

CREATE UNIQUE INDEX "warehouse_inventory_import_items_importId_rowNumber_key"
ON "warehouse_inventory_import_items"("importId", "rowNumber");
CREATE INDEX "warehouse_inventory_import_items_tenantId_productId_idx"
ON "warehouse_inventory_import_items"("tenantId", "productId");
CREATE INDEX "warehouse_inventory_import_items_tenantId_importId_idx"
ON "warehouse_inventory_import_items"("tenantId", "importId");

ALTER TABLE "product_external_codes"
ADD CONSTRAINT "product_external_codes_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_external_codes"
ADD CONSTRAINT "product_external_codes_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_inventory_imports"
ADD CONSTRAINT "warehouse_inventory_imports_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_inventory_imports"
ADD CONSTRAINT "warehouse_inventory_imports_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_inventory_import_items"
ADD CONSTRAINT "warehouse_inventory_import_items_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_inventory_import_items"
ADD CONSTRAINT "warehouse_inventory_import_items_tenantId_importId_fkey"
FOREIGN KEY ("tenantId", "importId") REFERENCES "warehouse_inventory_imports"("tenantId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_inventory_import_items"
ADD CONSTRAINT "warehouse_inventory_import_items_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
