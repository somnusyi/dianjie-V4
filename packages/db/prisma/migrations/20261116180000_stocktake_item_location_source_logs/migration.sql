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
  ADD COLUMN "additionSource" "WarehouseStocktakeAdditionSource" NOT NULL DEFAULT 'LEGACY';

-- Keep the LEGACY database default for one compatibility release so a
-- still-running 1.3.3 process cannot fail during the API cutover. New 1.3.4
-- writes set the source explicitly; a later release may remove this default
-- after the old runtime is no longer a supported rollback target.

CREATE INDEX "op_logs_tenant_entity_target_created_idx"
  ON "op_logs"("tenantId", "entityType", "targetId", "createdAt" DESC, "id" DESC);
