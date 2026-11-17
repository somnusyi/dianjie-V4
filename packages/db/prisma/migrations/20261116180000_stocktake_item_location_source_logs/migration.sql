-- Freeze a product's pick location and server-derived addition provenance on
-- each stocktake item. Historical rows intentionally remain location-unknown
-- and are marked LEGACY; current product data is never guessed retroactively.

CREATE TYPE "WarehouseStocktakeAdditionSource" AS ENUM (
  'LEGACY',
  'SYSTEM',
  'PLAN',
  'RECOUNT',
  'MANUAL',
  'MERGED'
);

ALTER TABLE "warehouse_stocktake_items"
  ADD COLUMN "storageLocationSnapshot" VARCHAR(32),
  ADD COLUMN "additionSource" "WarehouseStocktakeAdditionSource";

UPDATE "warehouse_stocktake_items"
SET "additionSource" = 'LEGACY'
WHERE "additionSource" IS NULL;

ALTER TABLE "warehouse_stocktake_items"
  ALTER COLUMN "additionSource" SET NOT NULL;

CREATE INDEX "op_logs_tenant_entity_target_created_idx"
  ON "op_logs"("tenantId", "entityType", "targetId", "createdAt" DESC, "id" DESC);
