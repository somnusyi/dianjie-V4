CREATE TABLE "product_upstream_sources" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "supplierSku" VARCHAR(80),
  "purchaseUnit" VARCHAR(16) NOT NULL,
  "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6) NOT NULL,
  "quotedUnitPrice" DECIMAL(14,4),
  "minOrderQty" DECIMAL(18,6) NOT NULL DEFAULT 1,
  "leadTimeDays" INTEGER NOT NULL DEFAULT 0,
  "note" VARCHAR(240),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_upstream_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_upstream_sources_tenantId_productId_supplierId_key"
  ON "product_upstream_sources"("tenantId", "productId", "supplierId");
CREATE INDEX "product_upstream_sources_tenantId_supplierId_isActive_idx"
  ON "product_upstream_sources"("tenantId", "supplierId", "isActive");
CREATE INDEX "product_upstream_sources_tenantId_productId_isPrimary_idx"
  ON "product_upstream_sources"("tenantId", "productId", "isPrimary");
CREATE UNIQUE INDEX "product_upstream_sources_one_active_primary_idx"
  ON "product_upstream_sources"("tenantId", "productId")
  WHERE "isPrimary" = true AND "isActive" = true;

ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_tenantId_productId_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_conversion_positive"
  CHECK ("inventoryUnitsPerPurchaseUnit" > 0);
ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_price_nonnegative"
  CHECK ("quotedUnitPrice" IS NULL OR "quotedUnitPrice" >= 0);
ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_min_order_positive"
  CHECK ("minOrderQty" > 0);
ALTER TABLE "product_upstream_sources"
  ADD CONSTRAINT "product_upstream_sources_lead_time_range"
  CHECK ("leadTimeDays" >= 0 AND "leadTimeDays" <= 365);
