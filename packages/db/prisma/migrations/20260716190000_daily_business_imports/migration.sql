-- Formalize POS dish variants and daily two-file import audit.
CREATE TYPE "DishInventoryPolicy" AS ENUM ('BOM', 'EXCLUDE');

ALTER TABLE "dishes"
  ADD COLUMN "inventoryPolicy" "DishInventoryPolicy" NOT NULL DEFAULT 'BOM',
  ADD COLUMN "inventoryPolicyNote" TEXT;

ALTER TABLE "dish_recipes"
  ADD COLUMN "variantKey" VARCHAR(80) NOT NULL DEFAULT '';

ALTER TABLE "dish_recipes"
  DROP CONSTRAINT IF EXISTS "dish_recipes_dishId_productId_key";

CREATE UNIQUE INDEX "dish_recipes_dishId_variantKey_productId_key"
  ON "dish_recipes"("dishId", "variantKey", "productId");

CREATE TABLE "daily_business_imports" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "businessFileName" TEXT NOT NULL,
  "businessFileHash" VARCHAR(64) NOT NULL,
  "salesFileName" TEXT NOT NULL,
  "salesFileHash" VARCHAR(64) NOT NULL,
  "grossAmount" DECIMAL(12,2) NOT NULL,
  "discountAmount" DECIMAL(12,2) NOT NULL,
  "netRevenue" DECIMAL(12,2) NOT NULL,
  "orderCount" INTEGER NOT NULL,
  "dishRowCount" INTEGER NOT NULL,
  "parsedData" JSONB NOT NULL,
  "previewData" JSONB NOT NULL,
  "blockingIssues" JSONB NOT NULL,
  "warningIssues" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "daily_business_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_business_imports_storeId_businessDate_revision_key"
  ON "daily_business_imports"("storeId", "businessDate", "revision");
CREATE UNIQUE INDEX "daily_import_file_pair_uk"
  ON "daily_business_imports"("storeId", "businessDate", "businessFileHash", "salesFileHash");
CREATE INDEX "daily_business_imports_tenantId_storeId_businessDate_idx"
  ON "daily_business_imports"("tenantId", "storeId", "businessDate");
CREATE INDEX "daily_business_imports_storeId_status_createdAt_idx"
  ON "daily_business_imports"("storeId", "status", "createdAt");
