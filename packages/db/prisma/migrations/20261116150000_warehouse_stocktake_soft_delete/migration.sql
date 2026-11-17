-- Reversible, audit-preserving removal of pre-posting warehouse stocktakes.
-- Children, entries, lifecycle events and batch evidence remain untouched.

ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'DELETE';
ALTER TYPE "WarehouseStocktakeBatchAction" ADD VALUE IF NOT EXISTS 'DELETE';

ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedById" TEXT,
  ADD COLUMN "deleteReason" VARCHAR(500);

ALTER TABLE "warehouse_stocktakes"
  ADD CONSTRAINT "wst_deleted_actor_fk"
  FOREIGN KEY ("tenantId", "deletedById")
  REFERENCES "users"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "wst_delete_tombstone_complete" CHECK (
    (
      "deletedAt" IS NULL
      AND "deletedById" IS NULL
      AND "deleteReason" IS NULL
    )
    OR
    (
      "deletedAt" IS NOT NULL
      AND "deletedById" IS NOT NULL
      AND "deleteReason" IS NOT NULL
      AND length(btrim("deleteReason")) >= 2
    )
  );

ALTER TABLE "warehouse_stocktake_lifecycle_events"
  DROP CONSTRAINT "warehouse_stocktake_lifecycle_cycle_by_action";

-- Cast enum values to text so this migration remains safe while PostgreSQL
-- commits the newly added enum value.
ALTER TABLE "warehouse_stocktake_lifecycle_events"
  ADD CONSTRAINT "warehouse_stocktake_lifecycle_cycle_by_action" CHECK (
    (
      "action"::text IN ('APPROVE', 'REVERSE_APPROVAL')
      AND "cycle" > 0
    )
    OR
    (
      "action"::text IN ('WITHDRAW', 'REJECT', 'HEADER_EDIT', 'ITEM_ADD', 'ITEM_REMOVE', 'DELETE')
      AND "cycle" = 0
    )
  );

DROP INDEX "wst_one_active_formal_per_warehouse_key";
CREATE UNIQUE INDEX "wst_one_active_formal_per_warehouse_key"
  ON "warehouse_stocktakes"("tenantId", "warehouseId")
  WHERE "status" IN ('DRAFT', 'COUNTING', 'REVIEWING')
    AND "documentType" <> 'MULTI'
    AND "deletedAt" IS NULL;

CREATE INDEX "wst_visible_document_date_idx"
  ON "warehouse_stocktakes"("tenantId", "deletedAt", "documentType", "countDate");
CREATE INDEX "wst_visible_warehouse_status_date_idx"
  ON "warehouse_stocktakes"("tenantId", "deletedAt", "warehouseId", "status", "countDate");
