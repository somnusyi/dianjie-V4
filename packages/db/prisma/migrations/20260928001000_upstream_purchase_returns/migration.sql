-- CreateEnum
CREATE TYPE "UpstreamPurchaseReturnStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpstreamPurchaseReturnEventType" AS ENUM ('CREATED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'RECEIVED');

-- AlterEnum
ALTER TYPE "WarehouseLedgerMovementType" ADD VALUE 'PURCHASE_RETURN';

-- CreateTable
CREATE TABLE "upstream_purchase_returns" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "status" "UpstreamPurchaseReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" VARCHAR(240) NOT NULL,
    "note" VARCHAR(500),
    "settlementAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "ledgerCostAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(160),
    "requestFingerprint" CHAR(64),
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(240),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" VARCHAR(240),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedNote" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_return_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" VARCHAR(64) NOT NULL,
    "receiptLineId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseQuantity" DECIMAL(18,6) NOT NULL,
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6) NOT NULL,
    "inventoryQuantity" DECIMAL(18,6) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "settlementUnitPrice" DECIMAL(18,6) NOT NULL,
    "settlementAmount" DECIMAL(20,4) NOT NULL,
    "ledgerCostAmount" DECIMAL(20,4),
    "ledgerMovementId" VARCHAR(64),
    "note" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_return_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" VARCHAR(64) NOT NULL,
    "type" "UpstreamPurchaseReturnEventType" NOT NULL,
    "fromStatus" "UpstreamPurchaseReturnStatus",
    "toStatus" "UpstreamPurchaseReturnStatus" NOT NULL,
    "actorId" TEXT NOT NULL,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_purchase_return_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upstream_purchase_returns_tenantId_supplierId_status_create_idx" ON "upstream_purchase_returns"("tenantId", "supplierId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_returns_tenantId_no_key" ON "upstream_purchase_returns"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_returns_tenantId_id_key" ON "upstream_purchase_returns"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_returns_tenantId_idempotencyKey_key" ON "upstream_purchase_returns"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_return_lines_ledgerMovementId_key" ON "upstream_purchase_return_lines"("ledgerMovementId");

-- CreateIndex
CREATE INDEX "upstream_purchase_return_lines_tenantId_productId_idx" ON "upstream_purchase_return_lines"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "upstream_purchase_return_lines_tenantId_receiptLineId_idx" ON "upstream_purchase_return_lines"("tenantId", "receiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_return_lines_returnId_receiptLineId_key" ON "upstream_purchase_return_lines"("returnId", "receiptLineId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_return_lines_tenantId_id_key" ON "upstream_purchase_return_lines"("tenantId", "id");

-- CreateIndex
CREATE INDEX "upstream_purchase_return_events_tenantId_returnId_createdAt_idx" ON "upstream_purchase_return_events"("tenantId", "returnId", "createdAt");

-- AddForeignKey
ALTER TABLE "upstream_purchase_returns" ADD CONSTRAINT "upstream_purchase_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_returns" ADD CONSTRAINT "upstream_purchase_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_returns" ADD CONSTRAINT "upstream_purchase_returns_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_lines" ADD CONSTRAINT "upstream_purchase_return_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_lines" ADD CONSTRAINT "upstream_purchase_return_lines_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "upstream_purchase_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_lines" ADD CONSTRAINT "upstream_purchase_return_lines_tenantId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "receiptLineId") REFERENCES "upstream_receipt_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_lines" ADD CONSTRAINT "upstream_purchase_return_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_lines" ADD CONSTRAINT "upstream_purchase_return_lines_ledgerMovementId_fkey" FOREIGN KEY ("ledgerMovementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_events" ADD CONSTRAINT "upstream_purchase_return_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_return_events" ADD CONSTRAINT "upstream_purchase_return_events_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "upstream_purchase_returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
