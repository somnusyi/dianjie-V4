-- Tenant warehouse foundation.
--
-- The supply-chain company is an internal tenant team. Supplier remains an
-- order/inventory attribution scope and does not own a warehouse.
--
-- Compatibility phase:
--   * legacy writers may omit warehouseId on delivery/inventory facts;
--   * BEFORE INSERT triggers fill only an omitted value with the tenant default;
--   * explicit forged/cross-tenant values are rejected by composite FKs;
--   * Product.stock remains the runtime write target and is mirrored one-way to
--     WarehouseStock.physicalQty.
-- After all runtime writers select a real warehouse explicitly and switch their
-- physical balance writes to WarehouseStock, make the five warehouseId columns
-- schema-required/NOT NULL and remove the compatibility triggers and functions.

-- Composite tenant keys are deliberate even where id is globally unique: they
-- are the referenced keys for tenant-bound warehouse/product foreign keys.
CREATE UNIQUE INDEX "products_tenantId_id_key"
ON "products"("tenantId", "id");

CREATE TABLE "warehouses" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouses_default_active_ck"
      CHECK (NOT "isDefault" OR "isActive")
);

CREATE TABLE "warehouse_stocks" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    -- Warehouse ledger quantities follow the confirmed three-decimal stock
    -- contract and the existing movement/batch precision.
    "physicalQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouses_tenantId_code_key"
ON "warehouses"("tenantId", "code");

CREATE UNIQUE INDEX "warehouses_tenantId_id_key"
ON "warehouses"("tenantId", "id");

-- PostgreSQL partial uniqueness is not expressible in Prisma schema syntax.
CREATE UNIQUE INDEX "warehouses_one_default_per_tenant_key"
ON "warehouses"("tenantId")
WHERE "isDefault";

CREATE INDEX "warehouses_tenantId_isActive_idx"
ON "warehouses"("tenantId", "isActive");

CREATE UNIQUE INDEX "warehouse_stocks_tenantId_warehouseId_productId_key"
ON "warehouse_stocks"("tenantId", "warehouseId", "productId");

CREATE INDEX "warehouse_stocks_tenantId_productId_idx"
ON "warehouse_stocks"("tenantId", "productId");

ALTER TABLE "warehouses"
ADD CONSTRAINT "warehouses_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocks"
ADD CONSTRAINT "warehouse_stocks_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocks"
ADD CONSTRAINT "warehouse_stocks_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocks"
ADD CONSTRAINT "warehouse_stocks_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId")
REFERENCES "products"("tenantId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Warehouse and WarehouseStock are tenant-owned foundation rows, while a
-- WarehouseStock is a derived balance for its warehouse/product. Cascades keep
-- existing tenant/product hard-delete cleanup compatible. Warehouse-bound
-- delivery and inventory facts below remain RESTRICT so audit data cannot be
-- removed by deleting a warehouse.

-- One deterministic, enabled tenant default warehouse for every historical
-- tenant. The id does not depend on supplier data and is stable across retries.
INSERT INTO "warehouses" (
    "id", "tenantId", "code", "name", "isDefault", "isActive",
    "createdAt", "updatedAt"
)
SELECT
    CONCAT('wh_', MD5(t."id" || ':default')),
    t."id",
    'default',
    '默认仓',
    true,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tenants" t;

-- Product.stock is the only deterministic historical physical-balance source.
-- Every product belongs to a tenant, regardless of whether supplierId is set.
INSERT INTO "warehouse_stocks" (
    "id", "tenantId", "warehouseId", "productId", "physicalQty",
    "createdAt", "updatedAt"
)
SELECT
    CONCAT('ws_', MD5(w."id" || ':' || p."id")),
    p."tenantId",
    w."id",
    p."id",
    p."stock",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "products" p
JOIN "warehouses" w
  ON w."tenantId" = p."tenantId"
 AND w."isDefault";

-- DeliveryOrder already had a nullable placeholder warehouseId. The remaining
-- warehouse-scoped facts receive the same compatibility-shaped column.
ALTER TABLE "supplier_stock_movements"
ADD COLUMN "warehouseId" VARCHAR(64);

ALTER TABLE "supplier_stock_batches"
ADD COLUMN "warehouseId" VARCHAR(64);

ALTER TABLE "supplier_stock_batch_allocations"
ADD COLUMN "warehouseId" VARCHAR(64);

ALTER TABLE "supplier_stock_reservations"
ADD COLUMN "warehouseId" VARCHAR(64);

-- The confirmed current model has exactly one tenant default warehouse, so all
-- historical facts bind to it. Existing DeliveryOrder placeholder values are
-- intentionally replaced rather than treated as warehouse identities.
UPDATE "delivery_orders" fact
SET "warehouseId" = w."id"
FROM "warehouses" w
WHERE w."tenantId" = fact."tenantId"
  AND w."isDefault";

UPDATE "supplier_stock_movements" fact
SET "warehouseId" = w."id"
FROM "warehouses" w
WHERE w."tenantId" = fact."tenantId"
  AND w."isDefault";

UPDATE "supplier_stock_batches" fact
SET "warehouseId" = w."id"
FROM "warehouses" w
WHERE w."tenantId" = fact."tenantId"
  AND w."isDefault";

UPDATE "supplier_stock_batch_allocations" fact
SET "warehouseId" = w."id"
FROM "warehouses" w
WHERE w."tenantId" = fact."tenantId"
  AND w."isDefault";

UPDATE "supplier_stock_reservations" fact
SET "warehouseId" = w."id"
FROM "warehouses" w
WHERE w."tenantId" = fact."tenantId"
  AND w."isDefault";

CREATE INDEX "delivery_orders_warehouse_status_created_idx"
ON "delivery_orders"("tenantId", "warehouseId", "status", "createdAt");

CREATE INDEX "supplier_stock_movements_warehouse_product_created_idx"
ON "supplier_stock_movements"("tenantId", "warehouseId", "productId", "createdAt");

CREATE INDEX "supplier_stock_batches_warehouse_product_balance_idx"
ON "supplier_stock_batches"("tenantId", "warehouseId", "productId", "remainingQty");

CREATE INDEX "supplier_stock_batch_allocations_warehouse_product_idx"
ON "supplier_stock_batch_allocations"("tenantId", "warehouseId", "productId");

CREATE INDEX "supplier_stock_reservations_warehouse_status_product_idx"
ON "supplier_stock_reservations"("tenantId", "warehouseId", "status", "productId");

-- Keep default creation deterministic for tenants created by the unchanged
-- runtime during the compatibility phase.
CREATE FUNCTION "ensure_tenant_default_warehouse"(target_tenant_id TEXT)
RETURNS VARCHAR(64)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    default_warehouse_id VARCHAR(64);
BEGIN
    SELECT w."id"
    INTO default_warehouse_id
    FROM "warehouses" w
    WHERE w."tenantId" = target_tenant_id
      AND w."isDefault"
    ORDER BY w."id"
    LIMIT 1;

    IF default_warehouse_id IS NOT NULL THEN
        RETURN default_warehouse_id;
    END IF;

    default_warehouse_id :=
      CONCAT('wh_', MD5(target_tenant_id || ':default'));

    INSERT INTO "warehouses" (
        "id", "tenantId", "code", "name", "isDefault", "isActive",
        "createdAt", "updatedAt"
    )
    VALUES (
        default_warehouse_id, target_tenant_id, 'default', '默认仓',
        true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId", "code") DO NOTHING;

    SELECT w."id"
    INTO default_warehouse_id
    FROM "warehouses" w
    WHERE w."tenantId" = target_tenant_id
      AND w."isDefault"
    ORDER BY w."id"
    LIMIT 1;

    IF default_warehouse_id IS NULL THEN
        RAISE EXCEPTION
          'tenant % has no enabled default warehouse', target_tenant_id
          USING ERRCODE = '23514';
    END IF;

    RETURN default_warehouse_id;
END;
$$;

CREATE FUNCTION "create_default_warehouse_for_tenant"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM "ensure_tenant_default_warehouse"(NEW."id");
    RETURN NEW;
END;
$$;

CREATE TRIGGER "tenants_create_default_warehouse_trg"
AFTER INSERT ON "tenants"
FOR EACH ROW
EXECUTE FUNCTION "create_default_warehouse_for_tenant"();

-- Legacy fact writers may omit warehouseId. Only NULL is filled; an explicit
-- caller value is preserved so the tenant composite FK can reject forgery.
CREATE FUNCTION "fill_tenant_default_warehouse_id"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."warehouseId" IS NULL THEN
        NEW."warehouseId" :=
          "ensure_tenant_default_warehouse"(NEW."tenantId");
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "delivery_orders_fill_default_warehouse_trg"
BEFORE INSERT ON "delivery_orders"
FOR EACH ROW
EXECUTE FUNCTION "fill_tenant_default_warehouse_id"();

CREATE TRIGGER "supplier_stock_movements_fill_default_warehouse_trg"
BEFORE INSERT ON "supplier_stock_movements"
FOR EACH ROW
EXECUTE FUNCTION "fill_tenant_default_warehouse_id"();

CREATE TRIGGER "supplier_stock_batches_fill_default_warehouse_trg"
BEFORE INSERT ON "supplier_stock_batches"
FOR EACH ROW
EXECUTE FUNCTION "fill_tenant_default_warehouse_id"();

CREATE TRIGGER "supplier_stock_batch_allocations_fill_default_warehouse_trg"
BEFORE INSERT ON "supplier_stock_batch_allocations"
FOR EACH ROW
EXECUTE FUNCTION "fill_tenant_default_warehouse_id"();

CREATE TRIGGER "supplier_stock_reservations_fill_default_warehouse_trg"
BEFORE INSERT ON "supplier_stock_reservations"
FOR EACH ROW
EXECUTE FUNCTION "fill_tenant_default_warehouse_id"();

-- Use NOT VALID + VALIDATE as an explicit low-lock migration phase. New writes
-- are checked immediately; validation proves all backfilled history is bound.
ALTER TABLE "delivery_orders"
ADD CONSTRAINT "delivery_orders_warehouse_present_ck"
CHECK ("warehouseId" IS NOT NULL) NOT VALID;

ALTER TABLE "supplier_stock_movements"
ADD CONSTRAINT "supplier_stock_movements_warehouse_present_ck"
CHECK ("warehouseId" IS NOT NULL) NOT VALID;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_warehouse_present_ck"
CHECK ("warehouseId" IS NOT NULL) NOT VALID;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_warehouse_present_ck"
CHECK ("warehouseId" IS NOT NULL) NOT VALID;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_warehouse_present_ck"
CHECK ("warehouseId" IS NOT NULL) NOT VALID;

ALTER TABLE "delivery_orders"
ADD CONSTRAINT "delivery_orders_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "supplier_stock_movements"
ADD CONSTRAINT "supplier_stock_movements_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "supplier_stock_batches"
ADD CONSTRAINT "supplier_stock_batches_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "supplier_stock_batch_allocations"
ADD CONSTRAINT "supplier_stock_batch_allocations_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId")
REFERENCES "warehouses"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "delivery_orders"
VALIDATE CONSTRAINT "delivery_orders_warehouse_present_ck";
ALTER TABLE "delivery_orders"
VALIDATE CONSTRAINT "delivery_orders_tenantId_warehouseId_fkey";

ALTER TABLE "supplier_stock_movements"
VALIDATE CONSTRAINT "supplier_stock_movements_warehouse_present_ck";
ALTER TABLE "supplier_stock_movements"
VALIDATE CONSTRAINT "supplier_stock_movements_tenantId_warehouseId_fkey";

ALTER TABLE "supplier_stock_batches"
VALIDATE CONSTRAINT "supplier_stock_batches_warehouse_present_ck";
ALTER TABLE "supplier_stock_batches"
VALIDATE CONSTRAINT "supplier_stock_batches_tenantId_warehouseId_fkey";

ALTER TABLE "supplier_stock_batch_allocations"
VALIDATE CONSTRAINT "supplier_stock_batch_allocations_warehouse_present_ck";
ALTER TABLE "supplier_stock_batch_allocations"
VALIDATE CONSTRAINT "supplier_stock_batch_allocations_tenantId_warehouseId_fkey";

ALTER TABLE "supplier_stock_reservations"
VALIDATE CONSTRAINT "supplier_stock_reservations_warehouse_present_ck";
ALTER TABLE "supplier_stock_reservations"
VALIDATE CONSTRAINT "supplier_stock_reservations_tenantId_warehouseId_fkey";

-- Temporary one-way bridge: Product -> WarehouseStock only.
-- Do not add a WarehouseStock -> Product trigger. Remove this function/trigger
-- after the runtime makes WarehouseStock the physical-balance write target.
CREATE FUNCTION "sync_product_stock_to_default_warehouse"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    default_warehouse_id VARCHAR(64);
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD."stock" IS NOT DISTINCT FROM NEW."stock" THEN
        RETURN NEW;
    END IF;

    default_warehouse_id :=
      "ensure_tenant_default_warehouse"(NEW."tenantId");

    INSERT INTO "warehouse_stocks" (
        "id", "tenantId", "warehouseId", "productId", "physicalQty",
        "rowVersion", "isActive", "createdAt", "updatedAt"
    )
    VALUES (
        CONCAT('ws_', MD5(default_warehouse_id || ':' || NEW."id")),
        NEW."tenantId",
        default_warehouse_id,
        NEW."id",
        NEW."stock",
        0,
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenantId", "warehouseId", "productId")
    DO UPDATE SET
        "physicalQty" = EXCLUDED."physicalQty",
        "rowVersion" = "warehouse_stocks"."rowVersion" + 1,
        "updatedAt" = CURRENT_TIMESTAMP;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "products_sync_default_warehouse_stock_trg"
AFTER INSERT OR UPDATE OF "stock" ON "products"
FOR EACH ROW
EXECUTE FUNCTION "sync_product_stock_to_default_warehouse"();
