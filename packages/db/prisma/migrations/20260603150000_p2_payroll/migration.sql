-- P2-1: 工资模块 (简化版: Excel 上传 + 自动凭证)
--   Payroll: 月工资单 batch + 状态机 (DRAFT/APPROVED/PAID/VOIDED)
--   PayrollItem: 每人明细 (姓名/底薪/奖金/扣项/实发)

CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'VOIDED');

CREATE TABLE "payrolls" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalGross" DECIMAL(12,2),
    "totalNet" DECIMAL(12,2) NOT NULL,
    "totalSocialSec" DECIMAL(12,2),
    "totalTax" DECIMAL(12,2),
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "payDate" TIMESTAMP(3),
    "payMethod" TEXT,
    "bankTxNo" TEXT,
    "voucherId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payrolls_tenantId_storeId_month_key"
  ON "payrolls"("tenantId", "storeId", "month");

CREATE INDEX "payrolls_tenantId_status_idx"
  ON "payrolls"("tenantId", "status");

ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "payroll_items" (
    "id" TEXT NOT NULL,
    "payrollId" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "position" TEXT,
    "baseSalary" DECIMAL(10,2),
    "bonus" DECIMAL(10,2),
    "overtime" DECIMAL(10,2),
    "deductSocialSec" DECIMAL(10,2),
    "deductTax" DECIMAL(10,2),
    "deductOther" DECIMAL(10,2),
    "netAmount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payroll_items_payrollId_idx" ON "payroll_items"("payrollId");

ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payrollId_fkey"
  FOREIGN KEY ("payrollId") REFERENCES "payrolls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
