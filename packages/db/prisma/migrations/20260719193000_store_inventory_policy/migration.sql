CREATE TABLE "store_inventory_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "minStock" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "targetStock" DECIMAL(18,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_inventory_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_inventory_policies_min_stock_ck" CHECK ("minStock" >= 0),
    CONSTRAINT "store_inventory_policies_target_stock_ck" CHECK ("targetStock" IS NULL OR "targetStock" >= "minStock")
);

CREATE UNIQUE INDEX "store_inventory_policies_storeId_productId_key"
  ON "store_inventory_policies"("storeId", "productId");
CREATE INDEX "store_inventory_policies_tenantId_storeId_idx"
  ON "store_inventory_policies"("tenantId", "storeId");

ALTER TABLE "store_inventory_policies" ADD CONSTRAINT "store_inventory_policies_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "store_inventory_policies" ADD CONSTRAINT "store_inventory_policies_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_inventory_policies" ADD CONSTRAINT "store_inventory_policies_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
