CREATE TYPE "StoreMonthlyCloseStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'SUPERSEDED');

CREATE TABLE "store_monthly_closes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "StoreMonthlyCloseStatus" NOT NULL DEFAULT 'DRAFT',
    "operatingRevenue" DECIMAL(14,2) NOT NULL,
    "revenueExTax" DECIMAL(14,2) NOT NULL,
    "vat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "surcharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "foodCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "beverageCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "consumablesCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "laborCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "salesExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "managementExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "financeExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "nonOperatingIncome" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "nonOperatingExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "profitBeforeTax" DECIMAL(14,2) NOT NULL,
    "incomeTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netProfit" DECIMAL(14,2) NOT NULL,
    "detail" JSONB,
    "sourceFilename" TEXT NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "store_monthly_closes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_monthly_closes_storeId_month_key" ON "store_monthly_closes"("storeId", "month");
CREATE INDEX "store_monthly_closes_tenantId_month_status_idx" ON "store_monthly_closes"("tenantId", "month", "status");
CREATE INDEX "store_monthly_closes_sourceHash_idx" ON "store_monthly_closes"("sourceHash");

ALTER TABLE "store_monthly_closes" ADD CONSTRAINT "store_monthly_closes_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "store_monthly_closes" ADD CONSTRAINT "store_monthly_closes_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "store_monthly_closes" ADD CONSTRAINT "store_monthly_closes_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
