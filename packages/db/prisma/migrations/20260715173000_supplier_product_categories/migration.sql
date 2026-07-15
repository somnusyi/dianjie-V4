-- 供应商商品/库存分类主数据。保留 products.category 作为兼容名称快照。
CREATE TABLE IF NOT EXISTS "supplier_product_categories" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "name" VARCHAR(40) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_product_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_product_categories_tenantId_supplierId_name_key"
  ON "supplier_product_categories"("tenantId", "supplierId", "name");

CREATE INDEX IF NOT EXISTS "supplier_product_categories_tenantId_supplierId_isActive_so_idx"
  ON "supplier_product_categories"("tenantId", "supplierId", "isActive", "sortOrder");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supplier_product_categories_tenantId_fkey') THEN
    ALTER TABLE "supplier_product_categories"
      ADD CONSTRAINT "supplier_product_categories_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supplier_product_categories_supplierId_fkey') THEN
    ALTER TABLE "supplier_product_categories"
      ADD CONSTRAINT "supplier_product_categories_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 将现有商品分类回填为正式主数据，不改动任何商品、库存或历史流水。
INSERT INTO "supplier_product_categories"
  ("id", "tenantId", "supplierId", "name", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
SELECT
  'spc_' || md5(random()::text || clock_timestamp()::text || p."supplierId" || p."category"),
  p."tenantId",
  p."supplierId",
  COALESCE(NULLIF(BTRIM(p."category"), ''), '其他'),
  ROW_NUMBER() OVER (PARTITION BY p."tenantId", p."supplierId" ORDER BY COALESCE(NULLIF(BTRIM(p."category"), ''), '其他')) - 1,
  true,
  COALESCE(NULLIF(BTRIM(p."category"), ''), '其他') = '其他',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT p."tenantId", p."supplierId", p."category"
  FROM "products" p
  INNER JOIN "suppliers" s
    ON s."id" = p."supplierId" AND s."tenantId" = p."tenantId"
  WHERE p."supplierId" IS NOT NULL
) p
ON CONFLICT ("tenantId", "supplierId", "name") DO NOTHING;
