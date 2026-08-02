-- Total-warehouse inventory shadow ledger.
--
-- This migration is expand-only. It deliberately does not change the meaning
-- of Product.stock or warehouse_stocks, because both still use the legacy
-- order-unit contract during the observation period.

CREATE TYPE "WarehouseInventoryMode" AS ENUM ('OFF', 'SHADOW', 'STRICT');
CREATE TYPE "WarehouseLedgerMovementType" AS ENUM (
    'OPENING_BALANCE',
    'MANUAL_INBOUND',
    'ORDER_RESERVED',
    'ORDER_RELEASED',
    'ORDER_OUTBOUND',
    'ADJUSTMENT',
    'LOSS',
    'REVERSAL'
);
CREATE TYPE "WarehouseLedgerReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
CREATE TYPE "WarehouseLedgerLotKind" AS ENUM ('OPENING', 'MANUAL_INBOUND', 'ADJUSTMENT');

ALTER TABLE "warehouses"
ADD COLUMN "inventoryMode" "WarehouseInventoryMode" NOT NULL DEFAULT 'OFF',
ADD COLUMN "inventoryActivatedAt" TIMESTAMP(3);

CREATE TABLE "warehouse_ledger_balances" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "physicalQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "reservedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "inventoryValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "averageUnitCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_ledger_balances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_ledger_movements" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "WarehouseLedgerMovementType" NOT NULL,
    "physicalDelta" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "reservedDelta" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "valueDelta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "physicalAfter" DECIMAL(18,6) NOT NULL,
    "reservedAfter" DECIMAL(18,6) NOT NULL,
    "valueAfter" DECIMAL(20,4) NOT NULL,
    "averageUnitCostAfter" DECIMAL(18,6) NOT NULL,
    "originalQuantity" DECIMAL(18,6) NOT NULL,
    "originalUnit" VARCHAR(16) NOT NULL,
    "conversionFactor" DECIMAL(18,6) NOT NULL,
    "inventoryQuantity" DECIMAL(18,6) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "sourceType" VARCHAR(50) NOT NULL,
    "sourceId" VARCHAR(80) NOT NULL,
    "sourceLineId" VARCHAR(80) NOT NULL DEFAULT '',
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "requestFingerprint" CHAR(64),
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "note" VARCHAR(240),
    "sourceName" VARCHAR(120),
    "createdById" TEXT,
    "reversalOfId" VARCHAR(64),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_ledger_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouse_ledger_movements_conversion_positive_chk" CHECK ("conversionFactor" > 0),
    CONSTRAINT "warehouse_ledger_movements_original_nonnegative_chk" CHECK ("originalQuantity" >= 0),
    CONSTRAINT "warehouse_ledger_movements_inventory_nonnegative_chk" CHECK ("inventoryQuantity" >= 0),
    CONSTRAINT "warehouse_ledger_movements_unit_cost_nonnegative_chk" CHECK ("inventoryUnitCost" >= 0),
    CONSTRAINT "warehouse_ledger_movements_average_cost_nonnegative_chk" CHECK ("averageUnitCostAfter" >= 0)
);

CREATE TABLE "warehouse_ledger_reservations" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "originalQuantity" DECIMAL(18,6) NOT NULL,
    "originalUnit" VARCHAR(16) NOT NULL,
    "conversionFactor" DECIMAL(18,6) NOT NULL,
    "inventoryQuantity" DECIMAL(18,6) NOT NULL,
    "fulfilledInventoryQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "status" "WarehouseLedgerReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_ledger_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouse_ledger_reservations_conversion_positive_chk" CHECK ("conversionFactor" > 0),
    CONSTRAINT "warehouse_ledger_reservations_quantity_positive_chk" CHECK ("inventoryQuantity" > 0),
    CONSTRAINT "warehouse_ledger_reservations_fulfilled_range_chk" CHECK ("fulfilledInventoryQty" >= 0 AND "fulfilledInventoryQty" <= "inventoryQuantity")
);

CREATE TABLE "warehouse_ledger_lots" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" "WarehouseLedgerLotKind" NOT NULL,
    "batchNo" VARCHAR(80) NOT NULL,
    "initialQty" DECIMAL(18,6) NOT NULL,
    "remainingQty" DECIMAL(18,6) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitCost" DECIMAL(18,6) NOT NULL,
    "sourceName" VARCHAR(120),
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "sourceMovementId" VARCHAR(64) NOT NULL,
    "depletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_ledger_lots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouse_ledger_lots_initial_positive_chk" CHECK ("initialQty" > 0),
    CONSTRAINT "warehouse_ledger_lots_remaining_range_chk" CHECK ("remainingQty" >= 0 AND "remainingQty" <= "initialQty"),
    CONSTRAINT "warehouse_ledger_lots_date_order_chk" CHECK ("expiryDate" IS NULL OR "manufactureDate" IS NULL OR "expiryDate" >= "manufactureDate"),
    CONSTRAINT "warehouse_ledger_lots_unit_cost_nonnegative_chk" CHECK ("inventoryUnitCost" >= 0)
);

CREATE TABLE "warehouse_ledger_lot_allocations" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "lotId" VARCHAR(64) NOT NULL,
    "movementId" VARCHAR(64) NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_ledger_lot_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouse_ledger_lot_allocations_quantity_positive_chk" CHECK ("quantity" > 0),
    CONSTRAINT "warehouse_ledger_lot_allocations_cost_nonnegative_chk" CHECK ("unitCost" >= 0 AND "value" >= 0)
);

CREATE UNIQUE INDEX "warehouse_ledger_balances_tenantId_warehouseId_productId_key"
ON "warehouse_ledger_balances"("tenantId", "warehouseId", "productId");
CREATE INDEX "warehouse_ledger_balances_tenantId_productId_idx"
ON "warehouse_ledger_balances"("tenantId", "productId");

CREATE UNIQUE INDEX "warehouse_ledger_movements_reversalOfId_key"
ON "warehouse_ledger_movements"("reversalOfId");
CREATE UNIQUE INDEX "warehouse_ledger_movements_tenantId_warehouseId_idempotency_key"
ON "warehouse_ledger_movements"("tenantId", "warehouseId", "idempotencyKey");
CREATE INDEX "warehouse_ledger_movements_tenantId_warehouseId_productId_e_idx"
ON "warehouse_ledger_movements"("tenantId", "warehouseId", "productId", "effectiveAt");
CREATE INDEX "warehouse_ledger_movements_tenantId_sourceType_sourceId_idx"
ON "warehouse_ledger_movements"("tenantId", "sourceType", "sourceId");

CREATE UNIQUE INDEX "warehouse_ledger_reservations_purchaseOrderItemId_key"
ON "warehouse_ledger_reservations"("purchaseOrderItemId");
CREATE INDEX "warehouse_ledger_reservations_tenantId_warehouseId_productI_idx"
ON "warehouse_ledger_reservations"("tenantId", "warehouseId", "productId", "status");
CREATE INDEX "warehouse_ledger_reservations_purchaseOrderId_status_idx"
ON "warehouse_ledger_reservations"("purchaseOrderId", "status");

CREATE UNIQUE INDEX "warehouse_ledger_lots_sourceMovementId_key"
ON "warehouse_ledger_lots"("sourceMovementId");
CREATE UNIQUE INDEX "warehouse_ledger_lots_tenantId_warehouseId_productId_batchN_key"
ON "warehouse_ledger_lots"("tenantId", "warehouseId", "productId", "batchNo");
CREATE INDEX "warehouse_ledger_lots_tenantId_warehouseId_productId_remain_idx"
ON "warehouse_ledger_lots"("tenantId", "warehouseId", "productId", "remainingQty");
CREATE INDEX "warehouse_ledger_lots_tenantId_warehouseId_expiryDate_idx"
ON "warehouse_ledger_lots"("tenantId", "warehouseId", "expiryDate");

CREATE UNIQUE INDEX "warehouse_ledger_lot_allocations_lotId_movementId_key"
ON "warehouse_ledger_lot_allocations"("lotId", "movementId");
CREATE INDEX "warehouse_ledger_lot_allocations_movementId_idx"
ON "warehouse_ledger_lot_allocations"("movementId");
CREATE INDEX "warehouse_ledger_lot_allocations_tenantId_warehouseId_produ_idx"
ON "warehouse_ledger_lot_allocations"("tenantId", "warehouseId", "productId");

ALTER TABLE "warehouse_ledger_balances"
ADD CONSTRAINT "warehouse_ledger_balances_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_balances"
ADD CONSTRAINT "warehouse_ledger_balances_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_balances"
ADD CONSTRAINT "warehouse_ledger_balances_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_ledger_movements"
ADD CONSTRAINT "warehouse_ledger_movements_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_movements"
ADD CONSTRAINT "warehouse_ledger_movements_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_movements"
ADD CONSTRAINT "warehouse_ledger_movements_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_movements"
ADD CONSTRAINT "warehouse_ledger_movements_reversalOfId_fkey"
FOREIGN KEY ("reversalOfId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_ledger_reservations"
ADD CONSTRAINT "warehouse_ledger_reservations_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_reservations"
ADD CONSTRAINT "warehouse_ledger_reservations_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_reservations"
ADD CONSTRAINT "warehouse_ledger_reservations_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_reservations"
ADD CONSTRAINT "warehouse_ledger_reservations_purchaseOrderId_fkey"
FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_reservations"
ADD CONSTRAINT "warehouse_ledger_reservations_purchaseOrderItemId_fkey"
FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_ledger_lots"
ADD CONSTRAINT "warehouse_ledger_lots_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lots"
ADD CONSTRAINT "warehouse_ledger_lots_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lots"
ADD CONSTRAINT "warehouse_ledger_lots_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lots"
ADD CONSTRAINT "warehouse_ledger_lots_sourceMovementId_fkey"
FOREIGN KEY ("sourceMovementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_ledger_lot_allocations"
ADD CONSTRAINT "warehouse_ledger_lot_allocations_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lot_allocations"
ADD CONSTRAINT "warehouse_ledger_lot_allocations_tenantId_warehouseId_fkey"
FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lot_allocations"
ADD CONSTRAINT "warehouse_ledger_lot_allocations_tenantId_productId_fkey"
FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lot_allocations"
ADD CONSTRAINT "warehouse_ledger_lot_allocations_lotId_fkey"
FOREIGN KEY ("lotId") REFERENCES "warehouse_ledger_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_ledger_lot_allocations"
ADD CONSTRAINT "warehouse_ledger_lot_allocations_movementId_fkey"
FOREIGN KEY ("movementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
