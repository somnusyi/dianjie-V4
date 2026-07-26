-- Safely widen Product master-data quantities from two to three decimals.
-- Existing two-decimal values remain exact; this migration performs no row DML.
--
-- Product.stock is referenced by the default-warehouse compatibility trigger.
-- PostgreSQL requires temporarily removing that trigger before changing the
-- column type. Recreate it below with the exact definition from the preceding
-- tenant warehouse migration.
--
-- Rollback safety: before narrowing to DECIMAL(10,2), prove every value has at
-- most two decimal places and fits the narrower range. Never automate a lossy
-- rollback when any third decimal is non-zero.

DROP TRIGGER "products_sync_default_warehouse_stock_trg" ON "products";

ALTER TABLE "products" ALTER COLUMN "stock" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "minStock" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "minOrderQty" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "stepQty" TYPE DECIMAL(12,3);

CREATE TRIGGER "products_sync_default_warehouse_stock_trg"
AFTER INSERT OR UPDATE OF "stock" ON "products"
FOR EACH ROW
EXECUTE FUNCTION "sync_product_stock_to_default_warehouse"();
