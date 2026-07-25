-- Manual rollback for 20260726120000_supply_document_four_unit_snapshots.
-- Roll application code back first. Existing receipt inventory-unit columns
-- predate this migration and are intentionally preserved.

ALTER TABLE "receipt_items"
  DROP COLUMN "unitConversionStatusSnapshot",
  DROP COLUMN "inventoryUnitsPerCostUnitSnapshot",
  DROP COLUMN "inventoryUnitsPerOrderUnitSnapshot",
  DROP COLUMN "costUnitSnapshot",
  DROP COLUMN "orderUnitSnapshot",
  DROP COLUMN "purchaseUnitSnapshot";

ALTER TABLE "delivery_order_items"
  DROP COLUMN "unitConversionStatusSnapshot",
  DROP COLUMN "inventoryUnitsPerCostUnitSnapshot",
  DROP COLUMN "inventoryUnitsPerOrderUnitSnapshot",
  DROP COLUMN "inventoryUnitsPerPurchaseUnitSnapshot",
  DROP COLUMN "costUnitSnapshot",
  DROP COLUMN "orderUnitSnapshot",
  DROP COLUMN "inventoryUnitSnapshot",
  DROP COLUMN "purchaseUnitSnapshot";

ALTER TABLE "purchase_order_items"
  DROP COLUMN "unitConversionStatusSnapshot",
  DROP COLUMN "inventoryUnitsPerCostUnitSnapshot",
  DROP COLUMN "inventoryUnitsPerOrderUnitSnapshot",
  DROP COLUMN "inventoryUnitsPerPurchaseUnitSnapshot",
  DROP COLUMN "costUnitSnapshot",
  DROP COLUMN "orderUnitSnapshot",
  DROP COLUMN "inventoryUnitSnapshot",
  DROP COLUMN "purchaseUnitSnapshot";
