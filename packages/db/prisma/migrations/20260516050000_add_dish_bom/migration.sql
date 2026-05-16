-- 菜品 BOM (总厨录配方, 销量×配方→食材消耗/毛利)
CREATE TYPE "DishStatus" AS ENUM ('ACTIVE', 'DISABLED', 'UPCOMING');

CREATE TABLE "dishes" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "code"        VARCHAR(40),
  "name"        TEXT NOT NULL,
  "category"    TEXT,
  "unit"        TEXT NOT NULL DEFAULT '份',
  "salePrice"   DECIMAL(10,2) NOT NULL,
  "imageUrl"    TEXT,
  "description" TEXT,
  "status"      "DishStatus" NOT NULL DEFAULT 'ACTIVE',
  "groupWide"   BOOLEAN NOT NULL DEFAULT true,
  "storeIds"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dishes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dishes_tenantId_name_key" ON "dishes"("tenantId", "name");
CREATE INDEX "dishes_tenantId_status_idx" ON "dishes"("tenantId", "status");

CREATE TABLE "dish_recipes" (
  "id"          TEXT NOT NULL,
  "dishId"      TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "quantity"    DECIMAL(10,4) NOT NULL,
  "unit"        TEXT NOT NULL,
  "lossRate"    DECIMAL(5,4) NOT NULL DEFAULT 0,
  "isMain"      BOOLEAN NOT NULL DEFAULT false,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dish_recipes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dish_recipes_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE,
  CONSTRAINT "dish_recipes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id")
);
CREATE UNIQUE INDEX "dish_recipes_dishId_productId_key" ON "dish_recipes"("dishId", "productId");
CREATE INDEX "dish_recipes_productId_idx" ON "dish_recipes"("productId");

CREATE TABLE "dish_sales" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "storeId"     TEXT NOT NULL,
  "dishId"      TEXT NOT NULL,
  "date"        DATE NOT NULL,
  "quantity"    DECIMAL(10,2) NOT NULL,
  "grossAmount" DECIMAL(12,2) NOT NULL,
  "source"      TEXT NOT NULL DEFAULT 'manual',
  "channel"     TEXT,
  "rawData"     JSONB,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dish_sales_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dish_sales_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id"),
  CONSTRAINT "dish_sales_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id")
);
CREATE UNIQUE INDEX "dish_sales_storeId_dishId_date_source_key" ON "dish_sales"("storeId", "dishId", "date", "source");
CREATE INDEX "dish_sales_tenantId_date_idx" ON "dish_sales"("tenantId", "date");
CREATE INDEX "dish_sales_dishId_date_idx" ON "dish_sales"("dishId", "date");
