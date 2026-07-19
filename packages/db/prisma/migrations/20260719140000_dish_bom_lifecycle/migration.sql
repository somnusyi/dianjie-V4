CREATE TYPE "DishBomVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE "DishBomChangeType" AS ENUM ('INITIAL', 'BUSINESS_CHANGE', 'HISTORICAL_CORRECTION');

ALTER TABLE "dishes"
ADD COLUMN "availableFrom" DATE,
ADD COLUMN "availableTo" DATE;

CREATE TABLE "dish_aliases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "source" VARCHAR(32) NOT NULL DEFAULT 'daily_pos',
    "rawName" VARCHAR(120) NOT NULL,
    "normalizedName" VARCHAR(120) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dish_aliases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dish_bom_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "variantKey" VARCHAR(80) NOT NULL DEFAULT '',
    "versionNo" INTEGER NOT NULL,
    "status" "DishBomVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "changeType" "DishBomChangeType" NOT NULL DEFAULT 'BUSINESS_CHANGE',
    "changeReason" VARCHAR(500),
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "createdById" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dish_bom_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dish_bom_items" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(14,6) NOT NULL,
    "unit" TEXT NOT NULL,
    "lossRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dish_bom_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dish_aliases_tenantId_source_normalizedName_key"
ON "dish_aliases"("tenantId", "source", "normalizedName");
CREATE INDEX "dish_aliases_dishId_isActive_idx" ON "dish_aliases"("dishId", "isActive");

CREATE UNIQUE INDEX "dish_bom_versions_dishId_variantKey_versionNo_key"
ON "dish_bom_versions"("dishId", "variantKey", "versionNo");
CREATE INDEX "dish_bom_versions_tenantId_status_effectiveFrom_idx"
ON "dish_bom_versions"("tenantId", "status", "effectiveFrom");
CREATE INDEX "dish_bom_versions_dishId_variantKey_status_effectiveFrom_idx"
ON "dish_bom_versions"("dishId", "variantKey", "status", "effectiveFrom");

CREATE UNIQUE INDEX "dish_bom_items_versionId_productId_key"
ON "dish_bom_items"("versionId", "productId");
CREATE INDEX "dish_bom_items_productId_idx" ON "dish_bom_items"("productId");

ALTER TABLE "dish_aliases"
ADD CONSTRAINT "dish_aliases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "dish_aliases_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dish_bom_versions"
ADD CONSTRAINT "dish_bom_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "dish_bom_versions_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dish_bom_items"
ADD CONSTRAINT "dish_bom_items_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "dish_bom_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "dish_bom_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 将当前可执行 BOM 冻结为版本 1。1970-01-01 使现有历史日报都能解析到该初始版本。
INSERT INTO "dish_bom_versions" (
    "id", "tenantId", "dishId", "variantKey", "versionNo", "status", "changeType",
    "changeReason", "effectiveFrom", "createdById", "publishedById", "publishedAt", "updatedAt"
)
SELECT
    'bomv_' || md5(r."dishId" || '|' || r."variantKey"),
    d."tenantId",
    r."dishId",
    r."variantKey",
    1,
    'PUBLISHED'::"DishBomVersionStatus",
    'INITIAL'::"DishBomChangeType",
    '系统升级：由现行 BOM 迁移为初始版本',
    DATE '1970-01-01',
    COALESCE(d."createdById", 'system-migration'),
    d."createdById",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "dishId", "variantKey" FROM "dish_recipes") r
JOIN "dishes" d ON d."id" = r."dishId";

INSERT INTO "dish_bom_items" (
    "id", "versionId", "productId", "quantity", "unit", "lossRate", "isMain", "note", "createdAt", "updatedAt"
)
SELECT
    'bomi_' || md5(r."id"),
    'bomv_' || md5(r."dishId" || '|' || r."variantKey"),
    r."productId",
    r."quantity",
    r."unit",
    r."lossRate",
    r."isMain",
    r."note",
    r."createdAt",
    r."updatedAt"
FROM "dish_recipes" r;

ALTER TABLE "stock_consumptions"
ADD COLUMN "sourceLineKey" VARCHAR(80) NOT NULL DEFAULT '',
ADD COLUMN "dishId" TEXT,
ADD COLUMN "variantKey" VARCHAR(80) NOT NULL DEFAULT '',
ADD COLUMN "bomVersionId" TEXT,
ADD COLUMN "calculationSnapshot" JSONB;

DROP INDEX IF EXISTS "stock_consumption_source_uk";
DROP INDEX IF EXISTS "stock_consumptions_sourceType_sourceId_productId_key";
CREATE UNIQUE INDEX "stock_consumption_source_line_uk"
ON "stock_consumptions"("sourceType", "sourceId", "sourceLineKey", "productId");
CREATE INDEX "stock_consumptions_dishId_date_idx" ON "stock_consumptions"("dishId", "date");
CREATE INDEX "stock_consumptions_bomVersionId_idx" ON "stock_consumptions"("bomVersionId");
ALTER TABLE "stock_consumptions"
ADD CONSTRAINT "stock_consumptions_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "stock_consumptions_bomVersionId_fkey" FOREIGN KEY ("bomVersionId") REFERENCES "dish_bom_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
