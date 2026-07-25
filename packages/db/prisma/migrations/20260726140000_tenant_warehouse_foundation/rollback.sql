-- Manual rollback for 20260726140000_tenant_warehouse_foundation.
--
-- Run only after rolling runtime code back to the pre-warehouse schema.
-- This deletes Warehouse/WarehouseStock foundation data. DeliveryOrder keeps
-- its pre-existing nullable placeholder column; its migrated values are cleared.
-- The temporary Product -> WarehouseStock one-way bridge and every legacy
-- warehouse-defaulting trigger are removed here.

DROP TRIGGER "products_sync_default_warehouse_stock_trg" ON "products";
DROP FUNCTION "sync_product_stock_to_default_warehouse"();

DROP TRIGGER "supplier_stock_reservations_fill_default_warehouse_trg"
ON "supplier_stock_reservations";
DROP TRIGGER "supplier_stock_batch_allocations_fill_default_warehouse_trg"
ON "supplier_stock_batch_allocations";
DROP TRIGGER "supplier_stock_batches_fill_default_warehouse_trg"
ON "supplier_stock_batches";
DROP TRIGGER "supplier_stock_movements_fill_default_warehouse_trg"
ON "supplier_stock_movements";
DROP TRIGGER "delivery_orders_fill_default_warehouse_trg"
ON "delivery_orders";
DROP FUNCTION "fill_tenant_default_warehouse_id"();

DROP TRIGGER "tenants_create_default_warehouse_trg" ON "tenants";
DROP FUNCTION "create_default_warehouse_for_tenant"();
DROP FUNCTION "ensure_tenant_default_warehouse"(TEXT);

ALTER TABLE "supplier_stock_reservations"
  DROP CONSTRAINT "supplier_stock_reservations_tenantId_warehouseId_fkey",
  DROP CONSTRAINT "supplier_stock_reservations_warehouse_present_ck";

ALTER TABLE "supplier_stock_batch_allocations"
  DROP CONSTRAINT "supplier_stock_batch_allocations_tenantId_warehouseId_fkey",
  DROP CONSTRAINT "supplier_stock_batch_allocations_warehouse_present_ck";

ALTER TABLE "supplier_stock_batches"
  DROP CONSTRAINT "supplier_stock_batches_tenantId_warehouseId_fkey",
  DROP CONSTRAINT "supplier_stock_batches_warehouse_present_ck";

ALTER TABLE "supplier_stock_movements"
  DROP CONSTRAINT "supplier_stock_movements_tenantId_warehouseId_fkey",
  DROP CONSTRAINT "supplier_stock_movements_warehouse_present_ck";

ALTER TABLE "delivery_orders"
  DROP CONSTRAINT "delivery_orders_tenantId_warehouseId_fkey",
  DROP CONSTRAINT "delivery_orders_warehouse_present_ck";

DROP INDEX "supplier_stock_reservations_warehouse_status_product_idx";
DROP INDEX "supplier_stock_batch_allocations_warehouse_product_idx";
DROP INDEX "supplier_stock_batches_warehouse_product_balance_idx";
DROP INDEX "supplier_stock_movements_warehouse_product_created_idx";
DROP INDEX "delivery_orders_warehouse_status_created_idx";

UPDATE "delivery_orders"
SET "warehouseId" = NULL;

ALTER TABLE "supplier_stock_reservations"
DROP COLUMN "warehouseId";

ALTER TABLE "supplier_stock_batch_allocations"
DROP COLUMN "warehouseId";

ALTER TABLE "supplier_stock_batches"
DROP COLUMN "warehouseId";

ALTER TABLE "supplier_stock_movements"
DROP COLUMN "warehouseId";

DROP TABLE "warehouse_stocks";
DROP TABLE "warehouses";

DROP INDEX "products_tenantId_id_key";
