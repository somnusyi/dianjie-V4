-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CapitalProjectType" AS ENUM ('NEW_STORE', 'RENOVATION', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CapitalProjectStatus" AS ENUM ('PREPARING', 'OPERATING', 'REPAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "CapitalCategory" AS ENUM ('RENT', 'DECORATION', 'EQUIPMENT', 'PAYROLL', 'LEGAL', 'MARKETING', 'OTHER');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "CapitalExpenseStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED', 'CANCELED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StoreLifecyclePhase" AS ENUM ('PLANNING', 'NEGOTIATING', 'CONSTRUCTION', 'EQUIPMENT', 'LICENSING', 'TRIAL', 'OPERATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "OpeningTaskCategory" AS ENUM ('BUSINESS', 'CONSTRUCTION', 'EQUIPMENT', 'LICENSING', 'PREPARATION');

-- CreateEnum
CREATE TYPE "OpeningTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED');

-- CreateEnum
CREATE TYPE "BudgetCategory" AS ENUM ('CONTRACT', 'CONSTRUCTION', 'FIRE', 'HVAC', 'VENTILATION', 'EQUIPMENT', 'MARKETING', 'HR', 'OTHER');

-- CreateEnum
CREATE TYPE "SkuApprovalAction" AS ENUM ('CREATE', 'DISABLE', 'BATCH');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('INITIAL', 'INBOUND_MANUAL', 'INBOUND_EXCEL', 'OUTBOUND_PO', 'ADJUSTMENT', 'LOSS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProductStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "ProductStatus" ADD VALUE 'PENDING_DISABLE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'KITCHEN_LEAD';
ALTER TYPE "Role" ADD VALUE 'CHEF_DIRECTOR';
ALTER TYPE "Role" ADD VALUE 'SUPPLIER_OWNER';
ALTER TYPE "Role" ADD VALUE 'ENGINEERING';

-- AlterEnum
ALTER TYPE "ScheduleStatus" ADD VALUE 'ON_HOLD';

-- DropForeignKey
ALTER TABLE "dish_recipes" DROP CONSTRAINT "dish_recipes_dishId_fkey";

-- DropForeignKey
ALTER TABLE "dish_recipes" DROP CONSTRAINT "dish_recipes_productId_fkey";

-- DropForeignKey
ALTER TABLE "dish_sales" DROP CONSTRAINT "dish_sales_dishId_fkey";

-- DropForeignKey
ALTER TABLE "dish_sales" DROP CONSTRAINT "dish_sales_storeId_fkey";

-- DropForeignKey
ALTER TABLE "loss_claims" DROP CONSTRAINT "loss_claims_purchaseOrderId_fkey";

-- DropForeignKey
ALTER TABLE "loss_claims" DROP CONSTRAINT "loss_claims_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "voucher_entries" DROP CONSTRAINT "voucher_entries_accountFkId_fkey";

-- DropForeignKey
ALTER TABLE "voucher_entries" DROP CONSTRAINT "voucher_entries_voucherId_fkey";

-- AlterTable
ALTER TABLE "loss_claims" ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reason" TEXT,
ALTER COLUMN "purchaseOrderId" DROP NOT NULL,
ALTER COLUMN "supplierId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "minOrderQty" DECIMAL(10,2) NOT NULL DEFAULT 1,
ADD COLUMN     "spec" TEXT,
ADD COLUMN     "stepQty" DECIMAL(10,2) NOT NULL DEFAULT 1,
ALTER COLUMN "category" SET DEFAULT '其他';

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "invoiceId" TEXT;

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "aggregatorApiKeyEnc" TEXT,
ADD COLUMN     "aggregatorMerchantId" TEXT,
ADD COLUMN     "aggregatorSecretEnc" TEXT,
ADD COLUMN     "aggregatorVendor" TEXT,
ADD COLUMN     "alipayAppId" TEXT,
ADD COLUMN     "alipayPrivateKeyEnc" TEXT,
ADD COLUMN     "autoSyncRevenue" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankAccountNo" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "douyinShopId" TEXT,
ADD COLUMN     "engineerId" TEXT,
ADD COLUMN     "expectedOpenAt" TIMESTAMP(3),
ADD COLUMN     "invoiceTaxId" TEXT,
ADD COLUMN     "lifecyclePhase" "StoreLifecyclePhase" NOT NULL DEFAULT 'OPERATING',
ADD COLUMN     "paymentChannelType" TEXT,
ADD COLUMN     "wechatApiV3KeyEnc" TEXT,
ADD COLUMN     "wechatMerchantId" TEXT;

-- CreateTable
CREATE TABLE "product_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "filename" TEXT,
    "totalRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL,
    "failedRows" JSONB,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceCode" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "amountWithoutTax" DECIMAL(12,2),
    "taxRate" DECIMAL(5,4),
    "taxAmount" DECIMAL(12,2),
    "issueDate" TIMESTAMP(3) NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL DEFAULT 'image',
    "note" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fullyPaidAt" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL DEFAULT 'cmb',
    "bankTxNo" TEXT,
    "bankRawResponse" JSONB,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "failReason" TEXT,
    "initiatedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_projects" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "type" "CapitalProjectType" NOT NULL DEFAULT 'NEW_STORE',
    "status" "CapitalProjectStatus" NOT NULL DEFAULT 'PREPARING',
    "budget" DECIMAL(12,2),
    "spent" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "repaymentTerms" TEXT,
    "repaidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capital_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_contracts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" "CapitalCategory" NOT NULL,
    "vendor" TEXT NOT NULL,
    "contractNo" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "fileUrl" TEXT,
    "note" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capital_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_expenses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT,
    "category" "CapitalCategory" NOT NULL,
    "vendor" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedById" TEXT NOT NULL,
    "fileUrl" TEXT,
    "note" TEXT,
    "status" "CapitalExpenseStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "rejectReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'cmb',
    "bankTxNo" TEXT,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capital_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_repayments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "bankTxNo" TEXT,
    "note" TEXT,
    "initiatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "requestedRole" "Role" NOT NULL,
    "reason" TEXT,
    "supplierId" TEXT,
    "supplierName" TEXT,
    "requestedStoreId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "storeId" TEXT,
    "supplierId" TEXT,
    "invitedById" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "category" "OpeningTaskCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" TEXT,
    "dueDate" TIMESTAMP(3),
    "status" "OpeningTaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(12,2),
    "capitalExpenseId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "blockerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opening_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_opening_budgets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "category" "BudgetCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "budget" DECIMAL(14,2),
    "contractAmount" DECIMAL(14,2),
    "paidAmount" DECIMAL(14,2),
    "approvalNo" TEXT,
    "note" TEXT,
    "voucherUrl" TEXT,
    "ownerRole" TEXT,
    "rowOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_opening_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "delta" DECIMAL(12,3) NOT NULL,
    "balanceAfter" DECIMAL(12,3) NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "reason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_tenantId_supplierId_idx" ON "product_batches"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "invoices_tenantId_status_idx" ON "invoices"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenantId_supplierId_invoiceNo_key" ON "invoices"("tenantId", "supplierId", "invoiceNo");

-- CreateIndex
CREATE INDEX "invoice_payments_tenantId_status_idx" ON "invoice_payments"("tenantId", "status");

-- CreateIndex
CREATE INDEX "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "capital_projects_tenantId_status_idx" ON "capital_projects"("tenantId", "status");

-- CreateIndex
CREATE INDEX "capital_contracts_tenantId_projectId_idx" ON "capital_contracts"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "capital_expenses_tenantId_status_idx" ON "capital_expenses"("tenantId", "status");

-- CreateIndex
CREATE INDEX "capital_expenses_projectId_contractId_idx" ON "capital_expenses"("projectId", "contractId");

-- CreateIndex
CREATE INDEX "store_repayments_tenantId_projectId_idx" ON "store_repayments"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "store_repayments_storeId_idx" ON "store_repayments"("storeId");

-- CreateIndex
CREATE INDEX "user_applications_tenantId_status_idx" ON "user_applications"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokens_token_key" ON "invite_tokens"("token");

-- CreateIndex
CREATE INDEX "invite_tokens_tenantId_consumedAt_revokedAt_idx" ON "invite_tokens"("tenantId", "consumedAt", "revokedAt");

-- CreateIndex
CREATE INDEX "opening_tasks_tenantId_storeId_status_idx" ON "opening_tasks"("tenantId", "storeId", "status");

-- CreateIndex
CREATE INDEX "store_opening_budgets_tenantId_storeId_idx" ON "store_opening_budgets"("tenantId", "storeId");

-- CreateIndex
CREATE INDEX "supplier_stock_movements_supplierId_productId_createdAt_idx" ON "supplier_stock_movements"("supplierId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "supplier_stock_movements_tenantId_createdAt_idx" ON "supplier_stock_movements"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "products_batchId_idx" ON "products"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_phone_key" ON "users"("tenantId", "phone");

-- AddForeignKey
ALTER TABLE "voucher_entries" ADD CONSTRAINT "voucher_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_entries" ADD CONSTRAINT "voucher_entries_accountFkId_fkey" FOREIGN KEY ("accountFkId") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_recipes" ADD CONSTRAINT "dish_recipes_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_recipes" ADD CONSTRAINT "dish_recipes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_sales" ADD CONSTRAINT "dish_sales_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_sales" ADD CONSTRAINT "dish_sales_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_projects" ADD CONSTRAINT "capital_projects_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_projects" ADD CONSTRAINT "capital_projects_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_contracts" ADD CONSTRAINT "capital_contracts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "capital_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_expenses" ADD CONSTRAINT "capital_expenses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "capital_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_expenses" ADD CONSTRAINT "capital_expenses_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "capital_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_repayments" ADD CONSTRAINT "store_repayments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "capital_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loss_claims" ADD CONSTRAINT "loss_claims_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_stock_movements" ADD CONSTRAINT "supplier_stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_stock_movements" ADD CONSTRAINT "supplier_stock_movements_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_stock_movements" ADD CONSTRAINT "supplier_stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_stock_movements" ADD CONSTRAINT "supplier_stock_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "stock_consumption_source_uk" RENAME TO "stock_consumptions_sourceType_sourceId_productId_key";
