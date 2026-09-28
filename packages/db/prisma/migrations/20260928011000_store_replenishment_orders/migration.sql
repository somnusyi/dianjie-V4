CREATE TYPE "ReplenishmentOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'CANCELLED');
CREATE TYPE "ReplenishmentOrderEventType" AS ENUM ('CREATED', 'EDITED', 'SUBMITTED', 'ACCEPTED', 'CANCELLED', 'DELIVERY_CREATED');

CREATE TABLE "replenishment_orders" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "expectedDate" DATE NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "ReplenishmentOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "source" VARCHAR(40) NOT NULL DEFAULT 'SUPPLY_CHAIN_PROXY',
    "note" VARCHAR(500),
    "idempotencyKey" VARCHAR(80),
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "acceptedById" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "replenishment_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "replenishment_orders_amount_check" CHECK ("totalAmount" >= 0),
    CONSTRAINT "replenishment_orders_row_version_check" CHECK ("rowVersion" >= 0),
    CONSTRAINT "replenishment_orders_state_fact_check" CHECK (
      ("status" = 'DRAFT' AND "submittedAt" IS NULL AND "submittedById" IS NULL AND "acceptedAt" IS NULL AND "acceptedById" IS NULL AND "cancelledAt" IS NULL AND "cancelledById" IS NULL)
      OR ("status" = 'SUBMITTED' AND "submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL AND "acceptedAt" IS NULL AND "acceptedById" IS NULL AND "cancelledAt" IS NULL AND "cancelledById" IS NULL)
      OR ("status" = 'ACCEPTED' AND "submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL AND "acceptedAt" IS NOT NULL AND "acceptedById" IS NOT NULL AND "cancelledAt" IS NULL AND "cancelledById" IS NULL)
      OR ("status" = 'CANCELLED' AND "acceptedAt" IS NULL AND "acceptedById" IS NULL AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL)
    )
);

CREATE TABLE "replenishment_order_items" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "replenishmentOrderId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "productCodeSnapshot" VARCHAR(80),
    "productNameSnapshot" VARCHAR(160) NOT NULL,
    "productSpecSnapshot" VARCHAR(240),
    "productCategorySnapshot" VARCHAR(100),
    "purchaseUnitSnapshot" VARCHAR(16),
    "inventoryUnitSnapshot" VARCHAR(16),
    "orderUnitSnapshot" VARCHAR(16),
    "costUnitSnapshot" VARCHAR(16),
    "unitConversionStatusSnapshot" "ProductUnitConversionStatus",
    "inventoryUnitsPerPurchaseUnitSnapshot" DECIMAL(18,6),
    "inventoryUnitsPerOrderUnitSnapshot" DECIMAL(18,6),
    "inventoryUnitsPerCostUnitSnapshot" DECIMAL(18,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replenishment_order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "replenishment_order_items_values_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "amount" >= 0)
);

CREATE TABLE "replenishment_order_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "replenishmentOrderId" VARCHAR(64) NOT NULL,
    "eventType" "ReplenishmentOrderEventType" NOT NULL,
    "actorId" TEXT,
    "actorRole" VARCHAR(40),
    "fromStatus" "ReplenishmentOrderStatus",
    "toStatus" "ReplenishmentOrderStatus",
    "requestId" VARCHAR(100),
    "requestKey" VARCHAR(80),
    "ip" VARCHAR(80),
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replenishment_order_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "replenishment_fulfillment_links" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "replenishmentOrderId" VARCHAR(64) NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replenishment_fulfillment_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "replenishment_orders_tenantId_no_key" ON "replenishment_orders"("tenantId", "no");
CREATE UNIQUE INDEX IF NOT EXISTS "stores_tenantId_id_key" ON "stores"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_tenantId_id_key" ON "purchase_orders"("tenantId", "id");
CREATE UNIQUE INDEX "replenishment_orders_tenantId_createdById_idempotencyKey_key" ON "replenishment_orders"("tenantId", "createdById", "idempotencyKey");
CREATE UNIQUE INDEX "replenishment_orders_tenantId_id_key" ON "replenishment_orders"("tenantId", "id");
CREATE INDEX "replenishment_orders_tenantId_storeId_status_createdAt_idx" ON "replenishment_orders"("tenantId", "storeId", "status", "createdAt");
CREATE INDEX "replenishment_orders_tenantId_supplierId_status_createdAt_idx" ON "replenishment_orders"("tenantId", "supplierId", "status", "createdAt");
CREATE UNIQUE INDEX "replenishment_order_items_replenishmentOrderId_productId_key" ON "replenishment_order_items"("replenishmentOrderId", "productId");
CREATE INDEX "replenishment_order_items_tenantId_productId_idx" ON "replenishment_order_items"("tenantId", "productId");
CREATE UNIQUE INDEX "replenishment_order_events_tenantId_requestKey_key" ON "replenishment_order_events"("tenantId", "requestKey");
CREATE INDEX "replenishment_order_events_tenantId_replenishmentOrderId_oc_idx" ON "replenishment_order_events"("tenantId", "replenishmentOrderId", "occurredAt");
CREATE UNIQUE INDEX "replenishment_fulfillment_links_replenishmentOrderId_key" ON "replenishment_fulfillment_links"("replenishmentOrderId");
CREATE UNIQUE INDEX "replenishment_fulfillment_links_purchaseOrderId_key" ON "replenishment_fulfillment_links"("purchaseOrderId");
CREATE UNIQUE INDEX "replenishment_fulfillment_links_tenantId_id_key" ON "replenishment_fulfillment_links"("tenantId", "id");
CREATE UNIQUE INDEX "replenishment_fulfillment_links_tenantId_replenishmentOrder_key" ON "replenishment_fulfillment_links"("tenantId", "replenishmentOrderId");
CREATE UNIQUE INDEX "replenishment_fulfillment_links_tenantId_purchaseOrderId_key" ON "replenishment_fulfillment_links"("tenantId", "purchaseOrderId");
CREATE INDEX "replenishment_fulfillment_links_tenantId_purchaseOrderId_idx" ON "replenishment_fulfillment_links"("tenantId", "purchaseOrderId");

ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_storeId_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "stores"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_submittedById_fkey" FOREIGN KEY ("tenantId", "submittedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_acceptedById_fkey" FOREIGN KEY ("tenantId", "acceptedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_tenantId_cancelledById_fkey" FOREIGN KEY ("tenantId", "cancelledById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_items" ADD CONSTRAINT "replenishment_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_items" ADD CONSTRAINT "replenishment_order_items_tenantId_replenishmentOrderId_fkey" FOREIGN KEY ("tenantId", "replenishmentOrderId") REFERENCES "replenishment_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_items" ADD CONSTRAINT "replenishment_order_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_events" ADD CONSTRAINT "replenishment_order_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_events" ADD CONSTRAINT "replenishment_order_events_tenantId_replenishmentOrderId_fkey" FOREIGN KEY ("tenantId", "replenishmentOrderId") REFERENCES "replenishment_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_order_events" ADD CONSTRAINT "replenishment_order_events_tenantId_actorId_fkey" FOREIGN KEY ("tenantId", "actorId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_fulfillment_links" ADD CONSTRAINT "replenishment_fulfillment_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "replenishment_fulfillment_links" ADD CONSTRAINT "replenishment_fulfillment_links_tenantId_replenishmentOrde_fkey" FOREIGN KEY ("tenantId", "replenishmentOrderId") REFERENCES "replenishment_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replenishment_fulfillment_links" ADD CONSTRAINT "replenishment_fulfillment_links_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
