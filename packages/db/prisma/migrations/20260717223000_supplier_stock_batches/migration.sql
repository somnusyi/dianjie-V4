CREATE TYPE "SupplierStockBatchKind" AS ENUM ('OPENING', 'INBOUND', 'ADJUSTMENT', 'RETURN');

CREATE TABLE "supplier_stock_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNo" VARCHAR(80) NOT NULL,
    "kind" "SupplierStockBatchKind" NOT NULL,
    "initialQty" DECIMAL(12,3) NOT NULL,
    "remainingQty" DECIMAL(12,3) NOT NULL,
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "sourceMovementId" TEXT,
    "createdById" TEXT,
    "depletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_stock_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_stock_batch_allocations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_stock_batch_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_stock_batches_sourceMovementId_key"
ON "supplier_stock_batches"("sourceMovementId");

CREATE UNIQUE INDEX "supplier_stock_batches_tenantId_productId_batchNo_key"
ON "supplier_stock_batches"("tenantId", "productId", "batchNo");

CREATE INDEX "supplier_stock_batches_scope_product_balance_idx"
ON "supplier_stock_batches"("tenantId", "supplierId", "productId", "remainingQty");

CREATE INDEX "supplier_stock_batches_scope_expiry_idx"
ON "supplier_stock_batches"("tenantId", "supplierId", "expiryDate");

CREATE UNIQUE INDEX "supplier_stock_batch_allocations_batchId_movementId_key"
ON "supplier_stock_batch_allocations"("batchId", "movementId");

CREATE INDEX "supplier_stock_batch_allocations_movementId_idx"
ON "supplier_stock_batch_allocations"("movementId");

CREATE INDEX "supplier_stock_batch_allocations_scope_product_idx"
ON "supplier_stock_batch_allocations"("tenantId", "supplierId", "productId");

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_supplierId_fkey"
FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_sourceMovementId_fkey"
FOREIGN KEY ("sourceMovementId") REFERENCES "supplier_stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_supplierId_fkey"
FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "supplier_stock_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_movementId_fkey"
FOREIGN KEY ("movementId") REFERENCES "supplier_stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing physical balances become one auditable opening batch per SKU. This
-- is intentionally based on Product.stock because historical movements did not
-- retain enough information to reconstruct unconsumed lots safely. Legacy
-- products can retain a supplierId whose supplier row was removed, so only
-- backfill rows whose supplier still exists in the same tenant.
INSERT INTO "supplier_stock_batches" (
    "id", "tenantId", "supplierId", "productId", "batchNo", "kind",
    "initialQty", "remainingQty", "createdAt", "updatedAt"
)
SELECT
    CONCAT('sb_', MD5(p."id" || ':opening:20260717')),
    p."tenantId",
    p."supplierId",
    p."id",
    'OPENING-20260717',
    'OPENING'::"SupplierStockBatchKind",
    p."stock",
    p."stock",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "products" p
JOIN "suppliers" s
  ON s."id" = p."supplierId"
 AND s."tenantId" = p."tenantId"
WHERE p."supplierId" IS NOT NULL
  AND p."stock" > 0;
