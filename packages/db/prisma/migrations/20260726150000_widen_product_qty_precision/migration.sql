-- Widen Product master-data quantities from two to three decimal places.
-- PostgreSQL requires the stock bridge trigger to be detached while changing
-- the type of a column named in its UPDATE OF clause. Prisma migrations run
-- transactionally, so no Product write can pass through without the bridge.
DROP TRIGGER "products_sync_default_warehouse_stock_trg" ON "products";

ALTER TABLE "products" ALTER COLUMN "stock" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "minStock" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "minOrderQty" TYPE DECIMAL(12,3);
ALTER TABLE "products" ALTER COLUMN "stepQty" TYPE DECIMAL(12,3);

CREATE TRIGGER "products_sync_default_warehouse_stock_trg"
AFTER INSERT OR UPDATE OF "stock" ON "products"
FOR EACH ROW
EXECUTE FUNCTION "sync_product_stock_to_default_warehouse"();

-- Manual rollback safety condition:
-- Before narrowing to DECIMAL(10,2), first prove that every value has at most
-- two decimal places and fits the narrower range. Do not automate a lossy rollback.
