CREATE TYPE "SupplierStockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

CREATE TABLE "supplier_stock_reservations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "fulfilledQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "status" "SupplierStockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_stock_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_stock_reservations_purchaseOrderItemId_key"
ON "supplier_stock_reservations"("purchaseOrderItemId");

CREATE INDEX "supplier_stock_reservations_scope_status_product_idx"
ON "supplier_stock_reservations"("tenantId", "supplierId", "status", "productId");

CREATE INDEX "supplier_stock_reservations_order_status_idx"
ON "supplier_stock_reservations"("purchaseOrderId", "status");

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_supplierId_fkey"
FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_purchaseOrderId_fkey"
FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_stock_reservations"
ADD CONSTRAINT "supplier_stock_reservations_purchaseOrderItemId_fkey"
FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
