-- 财务凭证 (好会计 Excel 导出兼容)
-- Spec: 替代财务录凭证工作, 业务事件 → 自动生成借贷分录 → 导出 Excel

-- 枚举
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
CREATE TYPE "VoucherStatus" AS ENUM ('DRAFT', 'POSTED', 'VOIDED');

-- 会计科目表
CREATE TABLE "chart_of_accounts" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "code"        VARCHAR(16) NOT NULL,
  "name"        TEXT NOT NULL,
  "type"        "AccountType" NOT NULL,
  "parentCode"  VARCHAR(16),
  "isDetail"    BOOLEAN NOT NULL DEFAULT true,
  "builtin"     BOOLEAN NOT NULL DEFAULT false,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chart_of_accounts_tenantId_code_key" ON "chart_of_accounts"("tenantId", "code");
CREATE INDEX "chart_of_accounts_tenantId_parentCode_idx" ON "chart_of_accounts"("tenantId", "parentCode");

-- 凭证主表
CREATE TABLE "vouchers" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "no"          TEXT NOT NULL,
  "date"        DATE NOT NULL,
  "word"        VARCHAR(8) NOT NULL DEFAULT '记',
  "summary"     TEXT NOT NULL,
  "sourceType"  TEXT,
  "sourceId"    TEXT,
  "totalDebit"  DECIMAL(14, 2) NOT NULL,
  "totalCredit" DECIMAL(14, 2) NOT NULL,
  "status"      "VoucherStatus" NOT NULL DEFAULT 'DRAFT',
  "postedAt"    TIMESTAMP(3),
  "postedById"  TEXT,
  "exportedAt"  TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vouchers_tenantId_no_key" ON "vouchers"("tenantId", "no");
CREATE INDEX "vouchers_tenantId_date_idx" ON "vouchers"("tenantId", "date");
CREATE INDEX "vouchers_tenantId_sourceType_sourceId_idx" ON "vouchers"("tenantId", "sourceType", "sourceId");

-- 凭证分录
CREATE TABLE "voucher_entries" (
  "id"          TEXT NOT NULL,
  "voucherId"   TEXT NOT NULL,
  "lineNo"      INTEGER NOT NULL,
  "summary"     TEXT NOT NULL,
  "accountCode" VARCHAR(16) NOT NULL,
  "accountName" TEXT NOT NULL,
  "debit"       DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "credit"      DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "accountFkId" TEXT,
  CONSTRAINT "voucher_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voucher_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE CASCADE,
  CONSTRAINT "voucher_entries_accountFkId_fkey" FOREIGN KEY ("accountFkId") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL
);
CREATE INDEX "voucher_entries_voucherId_idx" ON "voucher_entries"("voucherId");
CREATE INDEX "voucher_entries_accountCode_idx" ON "voucher_entries"("accountCode");
