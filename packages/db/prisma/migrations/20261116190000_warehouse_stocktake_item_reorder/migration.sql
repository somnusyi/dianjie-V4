-- Persist user-defined display order without changing stocktake quantities.

ALTER TYPE "WarehouseStocktakeLifecycleAction" ADD VALUE IF NOT EXISTS 'ITEM_REORDER';

ALTER TABLE "warehouse_stocktake_lifecycle_events"
  DROP CONSTRAINT "warehouse_stocktake_lifecycle_cycle_by_action";

ALTER TABLE "warehouse_stocktake_lifecycle_events"
  ADD CONSTRAINT "warehouse_stocktake_lifecycle_cycle_by_action" CHECK (
    (
      "action"::text IN ('APPROVE', 'REVERSE_APPROVAL')
      AND "cycle" > 0
    )
    OR
    (
      "action"::text IN ('WITHDRAW', 'REJECT', 'HEADER_EDIT', 'ITEM_ADD', 'ITEM_REMOVE', 'ITEM_REORDER', 'DELETE')
      AND "cycle" = 0
    )
  );
