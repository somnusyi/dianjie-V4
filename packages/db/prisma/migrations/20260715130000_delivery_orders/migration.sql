-- Delivery order P0: split fulfillment from immutable purchase orders.
-- Additive/forward-compatible migration. Existing order fields remain during compatibility period.

CREATE TYPE "DeliveryOrderStatus" AS ENUM ('DRAFT', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'CANCELLED');
CREATE TYPE "DeliveryOrderEventType" AS ENUM ('CREATED', 'UPDATED', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'CANCELLED', 'LEGACY_MIGRATED');

ALTER TABLE "receipts" DROP CONSTRAINT IF EXISTS "receipts_purchaseOrderId_key";
ALTER TABLE "receipts" ADD COLUMN "deliveryOrderId" TEXT;

CREATE TABLE "delivery_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64),
    "status" "DeliveryOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "actualTotalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "idempotencyKey" VARCHAR(80),
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "shippedById" TEXT,
    "deliveredById" TEXT,
    "receivedById" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "delivery_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "delivery_order_items" (
    "id" TEXT NOT NULL,
    "deliveryOrderId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT,
    "productId" TEXT NOT NULL,
    "orderedQtySnapshot" DECIMAL(10,2) NOT NULL,
    "shippedQty" DECIMAL(10,2) NOT NULL,
    "receivedQty" DECIMAL(10,2),
    "unitPriceSnapshot" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "delivery_order_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deliveryOrderId" TEXT NOT NULL,
    "eventType" "DeliveryOrderEventType" NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "fromStatus" "DeliveryOrderStatus",
    "toStatus" "DeliveryOrderStatus",
    "metadata" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_order_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_orders_tenantId_no_key" ON "delivery_orders"("tenantId", "no");
CREATE UNIQUE INDEX "delivery_orders_purchaseOrderId_idempotencyKey_key" ON "delivery_orders"("purchaseOrderId", "idempotencyKey");
CREATE INDEX "delivery_orders_tenantId_supplierId_status_createdAt_idx" ON "delivery_orders"("tenantId", "supplierId", "status", "createdAt");
CREATE INDEX "delivery_orders_tenantId_storeId_status_createdAt_idx" ON "delivery_orders"("tenantId", "storeId", "status", "createdAt");
CREATE UNIQUE INDEX "delivery_order_items_deliveryOrderId_productId_key" ON "delivery_order_items"("deliveryOrderId", "productId");
CREATE INDEX "delivery_order_items_productId_deliveryOrderId_idx" ON "delivery_order_items"("productId", "deliveryOrderId");
CREATE INDEX "delivery_order_events_deliveryOrderId_occurredAt_idx" ON "delivery_order_events"("deliveryOrderId", "occurredAt");
CREATE INDEX "delivery_order_events_tenantId_eventType_occurredAt_idx" ON "delivery_order_events"("tenantId", "eventType", "occurredAt");
CREATE UNIQUE INDEX "receipts_deliveryOrderId_key" ON "receipts"("deliveryOrderId");
CREATE INDEX "receipts_purchaseOrderId_deliveryDate_idx" ON "receipts"("purchaseOrderId", "deliveryDate");

-- Preserve the existing single receipt view while opening the full one-to-many relation.
UPDATE "purchase_orders" po
SET "receiptId" = r."id"
FROM "receipts" r
WHERE r."purchaseOrderId" = po."id" AND po."receiptId" IS NULL;

CREATE UNIQUE INDEX "purchase_orders_receiptId_key" ON "purchase_orders"("receiptId");

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_shippedById_fkey" FOREIGN KEY ("shippedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_order_items" ADD CONSTRAINT "delivery_order_items_deliveryOrderId_fkey" FOREIGN KEY ("deliveryOrderId") REFERENCES "delivery_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_order_items" ADD CONSTRAINT "delivery_order_items_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_order_items" ADD CONSTRAINT "delivery_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_order_events" ADD CONSTRAINT "delivery_order_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_order_events" ADD CONSTRAINT "delivery_order_events_deliveryOrderId_fkey" FOREIGN KEY ("deliveryOrderId") REFERENCES "delivery_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_order_events" ADD CONSTRAINT "delivery_order_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_deliveryOrderId_fkey" FOREIGN KEY ("deliveryOrderId") REFERENCES "delivery_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill one immutable compatibility delivery for historical fulfilled orders.
INSERT INTO "delivery_orders" (
    "id", "tenantId", "no", "purchaseOrderId", "storeId", "supplierId", "warehouseId",
    "status", "actualTotalAmount", "note", "rowVersion", "createdById", "shippedById",
    "deliveredById", "shippedAt", "deliveredAt", "receivedAt", "createdAt", "updatedAt"
)
SELECT
    'legacy-do-' || md5(po."id"), po."tenantId", 'DO-LEGACY-' || po."no", po."id", po."storeId", po."supplierId", NULL,
    CASE
      WHEN po."status" IN ('RECEIVED', 'COMPLETED') THEN 'RECEIVED'::"DeliveryOrderStatus"
      WHEN po."status" = 'PENDING_CONFIRM' THEN 'DELIVERED'::"DeliveryOrderStatus"
      ELSE 'SHIPPED'::"DeliveryOrderStatus"
    END,
    COALESCE(po."totalAmount", po."currentOrderAmount", po."originalTotalAmount", 0),
    po."shippedNote", 0, COALESCE(po."shippedById", po."createdById"), po."shippedById", po."deliveredById",
    COALESCE(po."shippedAt", po."createdAt"), po."deliveredAt", po."receivedAt", po."createdAt", po."updatedAt"
FROM "purchase_orders" po
WHERE po."shippedAt" IS NOT NULL OR po."status" IN ('DELIVERING', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED')
ON CONFLICT ("tenantId", "no") DO NOTHING;

INSERT INTO "delivery_order_items" (
    "id", "deliveryOrderId", "purchaseOrderItemId", "productId", "orderedQtySnapshot",
    "shippedQty", "receivedQty", "unitPriceSnapshot", "amount", "createdAt"
)
SELECT
    'legacy-di-' || md5(poi."id"), 'legacy-do-' || md5(poi."purchaseOrderId"), poi."id", poi."productId",
    poi."quantity", COALESCE(poi."shippedQty", poi."quantity"), poi."receivedQty", poi."unitPrice",
    COALESCE(poi."shippedQty", poi."quantity") * poi."unitPrice", po."createdAt"
FROM "purchase_order_items" poi
JOIN "purchase_orders" po ON po."id" = poi."purchaseOrderId"
JOIN "delivery_orders" d ON d."id" = 'legacy-do-' || md5(po."id")
WHERE poi."isActive" = TRUE
ON CONFLICT ("deliveryOrderId", "productId") DO NOTHING;

INSERT INTO "delivery_order_events" (
    "id", "tenantId", "deliveryOrderId", "eventType", "actorId", "actorRole", "toStatus", "metadata", "occurredAt"
)
SELECT
    'legacy-de-' || md5(d."id"), d."tenantId", d."id", 'LEGACY_MIGRATED', d."shippedById", NULL, d."status",
    jsonb_build_object('purchaseOrderId', d."purchaseOrderId", 'migration', '20260715130000_delivery_orders'), d."createdAt"
FROM "delivery_orders" d
WHERE d."id" LIKE 'legacy-do-%'
ON CONFLICT ("id") DO NOTHING;

UPDATE "receipts" r
SET "deliveryOrderId" = 'legacy-do-' || md5(r."purchaseOrderId")
WHERE r."purchaseOrderId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "delivery_orders" d WHERE d."id" = 'legacy-do-' || md5(r."purchaseOrderId"));

UPDATE "supplier_stock_movements" sm
SET "sourceType" = 'DeliveryOrder', "sourceId" = 'legacy-do-' || md5(sm."sourceId")
WHERE sm."sourceType" = 'PurchaseOrder'
  AND sm."sourceId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "delivery_orders" d WHERE d."id" = 'legacy-do-' || md5(sm."sourceId"));
