ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "documentType" VARCHAR(16) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "sourceMultiId" VARCHAR(64),
  ADD COLUMN "generatedStocktakeId" VARCHAR(64),
  ADD COLUMN "generatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "warehouse_stocktakes_tenantId_sourceMultiId_key"
  ON "warehouse_stocktakes"("tenantId", "sourceMultiId");

CREATE INDEX "wst_tenant_document_type_date_idx"
  ON "warehouse_stocktakes"("tenantId", "documentType", "countDate");

-- 多人盘点是多张并行独立子单；正式/历史盘点仍保持同仓单活动单互斥。
DROP INDEX "wst_one_active_per_warehouse_key";
CREATE UNIQUE INDEX "wst_one_active_formal_per_warehouse_key"
  ON "warehouse_stocktakes"("tenantId", "warehouseId")
  WHERE "status" IN ('DRAFT', 'COUNTING', 'REVIEWING') AND "documentType" <> 'MULTI';

ALTER TABLE "warehouse_stocktakes"
  ADD CONSTRAINT "wst_source_multi_fk"
  FOREIGN KEY ("tenantId", "sourceMultiId")
  REFERENCES "warehouse_stocktakes"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocktakes"
  ADD CONSTRAINT "wst_generated_stocktake_fk"
  FOREIGN KEY ("tenantId", "generatedStocktakeId")
  REFERENCES "warehouse_stocktakes"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocktakes"
  ADD CONSTRAINT "warehouse_stocktakes_document_type_check"
  CHECK ("documentType" IN ('LEGACY', 'MULTI', 'FORMAL'));

CREATE TABLE "warehouse_stocktake_merge_sources" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceStocktakeId" VARCHAR(64) NOT NULL,
  "formalStocktakeId" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_merge_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_merge_source_fk" FOREIGN KEY ("tenantId", "sourceStocktakeId")
    REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_merge_formal_fk" FOREIGN KEY ("tenantId", "formalStocktakeId")
    REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_merge_tenant_source_key"
  ON "warehouse_stocktake_merge_sources"("tenantId", "sourceStocktakeId");
CREATE UNIQUE INDEX "wst_merge_tenant_formal_source_key"
  ON "warehouse_stocktake_merge_sources"("tenantId", "formalStocktakeId", "sourceStocktakeId");
CREATE INDEX "wst_merge_tenant_formal_idx"
  ON "warehouse_stocktake_merge_sources"("tenantId", "formalStocktakeId");

INSERT INTO "warehouse_stocktake_merge_sources" ("id", "tenantId", "sourceStocktakeId", "formalStocktakeId")
SELECT 'legacy-' || md5("tenantId" || ':' || "id"), "tenantId", "id", "generatedStocktakeId"
FROM "warehouse_stocktakes"
WHERE "documentType" = 'MULTI' AND "generatedStocktakeId" IS NOT NULL
ON CONFLICT ("tenantId", "sourceStocktakeId") DO NOTHING;
