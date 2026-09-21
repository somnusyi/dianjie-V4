-- CreateEnum
CREATE TYPE "StoreTransferStatus" AS ENUM ('PENDING', 'SHIPPED', 'RECEIVED', 'REVOKED');

-- CreateTable
CREATE TABLE "store_transfers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "fromStoreId" TEXT NOT NULL,
    "toStoreId" TEXT NOT NULL,
    "transferDate" DATE NOT NULL,
    "status" "StoreTransferStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "shippedById" TEXT,
    "receivedById" TEXT,
    "revokedById" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "store_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_transfer_items" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "spec" TEXT,
    "category" TEXT,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "cost" DECIMAL(18,6) NOT NULL,
    "settlement" DECIMAL(18,6) NOT NULL,
    "outAmount" DECIMAL(20,4) NOT NULL,
    "inAmount" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "store_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_transfers_tenantId_transferDate_status_idx" ON "store_transfers"("tenantId", "transferDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "store_transfers_tenantId_no_key" ON "store_transfers"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "store_transfers_tenantId_requestKey_key" ON "store_transfers"("tenantId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "store_transfer_items_transferId_productId_key" ON "store_transfer_items"("transferId", "productId");

-- AddForeignKey
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_fromStoreId_fkey" FOREIGN KEY ("fromStoreId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_toStoreId_fkey" FOREIGN KEY ("toStoreId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_items" ADD CONSTRAINT "store_transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "store_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_transfer_items" ADD CONSTRAINT "store_transfer_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

