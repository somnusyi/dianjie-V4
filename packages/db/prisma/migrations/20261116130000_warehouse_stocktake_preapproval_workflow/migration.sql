-- Append-only evidence for stocktake actions before approval.
-- PostgreSQL enum values are added without rewriting existing rows.

ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'WITHDRAW';
ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'REJECT';
ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'HEADER_EDIT';
ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'ITEM_ADD';
ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'ITEM_REMOVE';

ALTER TABLE "warehouse_stocktake_lifecycle_events"
  DROP CONSTRAINT "warehouse_stocktake_lifecycle_cycle_positive";

-- Cast the enum to text so the new enum values can safely be referenced in
-- the same migration transaction. Approval evidence always belongs to a
-- positive posting cycle; pre-approval evidence always belongs to cycle zero.
ALTER TABLE "warehouse_stocktake_lifecycle_events"
  ADD CONSTRAINT "warehouse_stocktake_lifecycle_cycle_by_action" CHECK (
    (
      "action"::text IN ('APPROVE', 'REVERSE_APPROVAL')
      AND "cycle" > 0
    )
    OR
    (
      "action"::text IN ('WITHDRAW', 'REJECT', 'HEADER_EDIT', 'ITEM_ADD', 'ITEM_REMOVE')
      AND "cycle" = 0
    )
  );
