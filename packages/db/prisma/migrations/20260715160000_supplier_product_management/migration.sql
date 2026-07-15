-- Supplier product management P1: durable main-image key and query index.
-- Existing product/order/inventory data is preserved.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "imageKey" TEXT;

CREATE INDEX IF NOT EXISTS "products_tenantId_supplierId_category_status_idx"
ON "products"("tenantId", "supplierId", "category", "status");
