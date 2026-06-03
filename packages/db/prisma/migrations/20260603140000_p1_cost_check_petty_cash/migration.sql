-- P1: 月度成本核对工作台 + 备用金管理
--   1. Supplier.sourceType (HEADQ/B2B/SCATTERED) — 财务月度核对 3 栏分类
--   2. Receipt 三方核对字段 (supplier + finance) — 真实业务"三方对账才入账"
--   3. PettyCash + PettyCashExpense — 备用金 申请/发放/月底回收 闭环

-- 1. Supplier.sourceType
CREATE TYPE "SupplierSourceType" AS ENUM ('HEADQ_WAREHOUSE', 'B2B_PLATFORM', 'SCATTERED');

ALTER TABLE "suppliers" ADD COLUMN "sourceType" "SupplierSourceType";

-- 2. Receipt 三方核对字段 (供应商 + 财务. 门店店长=createdBy, 厨师长=confirmedAt 已有)
ALTER TABLE "receipts" ADD COLUMN "supplierVerifiedAt"   TIMESTAMP(3);
ALTER TABLE "receipts" ADD COLUMN "supplierVerifiedById" TEXT;
ALTER TABLE "receipts" ADD COLUMN "supplierVerifyNote"   TEXT;
ALTER TABLE "receipts" ADD COLUMN "financeVerifiedAt"   TIMESTAMP(3);
ALTER TABLE "receipts" ADD COLUMN "financeVerifiedById" TEXT;
ALTER TABLE "receipts" ADD COLUMN "financeVerifyNote"   TEXT;

-- 3. PettyCash 备用金
CREATE TYPE "PettyCashStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'RECONCILING', 'CLOSED', 'CANCELED');

CREATE TABLE "petty_cash" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "requestedAmount" DECIMAL(12,2) NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestNote" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedAmount" DECIMAL(12,2),
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentMethod" TEXT,
    "bankTxNo" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledById" TEXT,
    "spentAmount" DECIMAL(12,2),
    "returnedAmount" DECIMAL(12,2),
    "reconcileNote" TEXT,
    "status" "PettyCashStatus" NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "petty_cash_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "petty_cash_tenantId_storeId_month_key"
  ON "petty_cash"("tenantId", "storeId", "month");

CREATE INDEX "petty_cash_tenantId_status_idx"
  ON "petty_cash"("tenantId", "status");

ALTER TABLE "petty_cash" ADD CONSTRAINT "petty_cash_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "petty_cash" ADD CONSTRAINT "petty_cash_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "petty_cash_expenses" (
    "id" TEXT NOT NULL,
    "pettyCashId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "attachments" TEXT[],
    "receiptId" TEXT,
    "supplierId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "petty_cash_expenses_pettyCashId_idx" ON "petty_cash_expenses"("pettyCashId");

ALTER TABLE "petty_cash_expenses" ADD CONSTRAINT "petty_cash_expenses_pettyCashId_fkey"
  FOREIGN KEY ("pettyCashId") REFERENCES "petty_cash"("id") ON DELETE CASCADE ON UPDATE CASCADE;
