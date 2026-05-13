-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'PURCHASER', 'SUPPLIER_STAFF', 'CHEF');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CreditType" AS ENUM ('FIXED_DAYS', 'MONTHLY', 'WEEKLY', 'ON_DELIVERY');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'PENDING', 'PENDING_CONFIRM', 'CONFIRMED', 'ACCOUNTED', 'VOID', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PENDING', 'NOTIFIED', 'PROCESSING', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'PAYMENT_GENERATED', 'DONE');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('UNPAID', 'PAYING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PayMethod" AS ENUM ('BANK_TRANSFER', 'ALIPAY', 'WECHAT', 'CASH');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LossClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'NEGOTIATING', 'RESOLVED', 'AUTO_APPROVED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "storeId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "managerName" TEXT,
    "status" "StoreStatus" NOT NULL DEFAULT 'ENABLED',
    "meituanShopId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_records" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "category" TEXT,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ENABLED',
    "creditType" "CreditType" NOT NULL DEFAULT 'FIXED_DAYS',
    "creditDays" INTEGER NOT NULL DEFAULT 30,
    "autoPay" BOOLEAN NOT NULL DEFAULT false,
    "autoPayLimit" DECIMAL(12,2),
    "bankName" TEXT,
    "bankAccount" TEXT,
    "bankAccountName" TEXT,
    "scoreTotal" INTEGER NOT NULL DEFAULT 80,
    "onTimeRate" INTEGER NOT NULL DEFAULT 90,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "price" DECIMAL(10,2) NOT NULL,
    "stock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "minStock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shelfDays" INTEGER NOT NULL DEFAULT 7,
    "status" "ProductStatus" NOT NULL DEFAULT 'ENABLED',
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "tempSupplierName" TEXT,
    "tempBankAccount" TEXT,
    "tempBankName" TEXT,
    "rejectReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "purchaseOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_items" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_consumptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "creditDays" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "notified3Days" BOOLEAN NOT NULL DEFAULT false,
    "notified1Day" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "ReconStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_items" (
    "id" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "reconciliationId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PayMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "status" "PayStatus" NOT NULL DEFAULT 'UNPAID',
    "bankTxNo" TEXT,
    "bankRawResponse" JSONB,
    "note" TEXT,
    "paidAt" TIMESTAMP(3),
    "failReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "expectedDate" DATE NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "shippedAt" TIMESTAMP(3),
    "shippedNote" TEXT,
    "shippedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "autoConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "receiptId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "receivedQty" DECIMAL(10,2),

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loss_claims" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "totalLossAmount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceImages" TEXT[],
    "status" "LossClaimStatus" NOT NULL DEFAULT 'PENDING',
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "handlerNote" TEXT,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "negotiationNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loss_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loss_claim_items" (
    "id" TEXT NOT NULL,
    "lossClaimId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderedQty" DECIMAL(10,2) NOT NULL,
    "receivedQty" DECIMAL(10,2) NOT NULL,
    "lossQty" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lossAmount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "loss_claim_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "condition" TEXT NOT NULL,
    "threshold" DECIMAL(12,2),
    "action" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "op_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "targetId" TEXT,
    "entityType" TEXT,
    "metadata" JSONB,
    "isAi" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "op_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "stores_tenantId_no_key" ON "stores"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_records_storeId_date_key" ON "revenue_records"("storeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_no_key" ON "suppliers"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_code_key" ON "products"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_purchaseOrderId_key" ON "receipts"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_tenantId_no_key" ON "receipts"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_receiptId_key" ON "payment_schedules"("receiptId");

-- CreateIndex
CREATE INDEX "payment_schedules_dueAt_status_idx" ON "payment_schedules"("dueAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliations_tenantId_no_key" ON "reconciliations"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_no_key" ON "payments"("tenantId", "no");

-- CreateIndex
CREATE INDEX "purchase_orders_supplierId_status_idx" ON "purchase_orders"("supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_tenantId_no_key" ON "purchase_orders"("tenantId", "no");

-- CreateIndex
CREATE INDEX "loss_claims_supplierId_status_idx" ON "loss_claims"("supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loss_claims_tenantId_no_key" ON "loss_claims"("tenantId", "no");

-- CreateIndex
CREATE INDEX "payment_rules_tenantId_enabled_idx" ON "payment_rules"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "op_logs_tenantId_createdAt_idx" ON "op_logs"("tenantId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_records" ADD CONSTRAINT "revenue_records_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "reconciliations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shippedById_fkey" FOREIGN KEY ("shippedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claim_items" ADD CONSTRAINT "loss_claim_items_lossClaimId_fkey" FOREIGN KEY ("lossClaimId") REFERENCES "loss_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claim_items" ADD CONSTRAINT "loss_claim_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_rules" ADD CONSTRAINT "payment_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_logs" ADD CONSTRAINT "op_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "op_logs" ADD CONSTRAINT "op_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
