CREATE TYPE "DeferredBomTaskStatus" AS ENUM ('PENDING', 'BACKFILLED', 'SUPERSEDED');

CREATE TABLE "deferred_bom_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "dailyBusinessImportId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "rawDishName" VARCHAR(120) NOT NULL,
    "spec" VARCHAR(120) NOT NULL DEFAULT '',
    "variantKey" VARCHAR(80) NOT NULL DEFAULT '',
    "reasonCode" VARCHAR(32) NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "netIncome" DECIMAL(12,2) NOT NULL,
    "rawData" JSONB NOT NULL,
    "saleRecorded" BOOLEAN NOT NULL DEFAULT false,
    "dishId" TEXT,
    "status" "DeferredBomTaskStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "backfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deferred_bom_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deferred_bom_task_import_dish_variant_uk"
ON "deferred_bom_tasks"("dailyBusinessImportId", "rawDishName", "variantKey");
CREATE INDEX "deferred_bom_tasks_tenantId_status_businessDate_idx"
ON "deferred_bom_tasks"("tenantId", "status", "businessDate");
CREATE INDEX "deferred_bom_tasks_dishId_status_idx"
ON "deferred_bom_tasks"("dishId", "status");

ALTER TABLE "deferred_bom_tasks"
ADD CONSTRAINT "deferred_bom_tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferred_bom_tasks"
ADD CONSTRAINT "deferred_bom_tasks_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferred_bom_tasks"
ADD CONSTRAINT "deferred_bom_tasks_dailyBusinessImportId_fkey" FOREIGN KEY ("dailyBusinessImportId") REFERENCES "daily_business_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deferred_bom_tasks"
ADD CONSTRAINT "deferred_bom_tasks_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deferred_bom_tasks"
ADD CONSTRAINT "deferred_bom_tasks_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
