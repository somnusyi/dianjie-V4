-- V5 phase 2, batch 1: freeze the Product four-unit contract on supply
-- document lines. All columns are deliberately nullable for historical rows.
-- Do not infer or backfill relationships from product specs, current Product
-- values, quantities, prices, or historical amounts.

ALTER TABLE "purchase_order_items"
  ADD COLUMN "purchaseUnitSnapshot" VARCHAR(16),
  ADD COLUMN "inventoryUnitSnapshot" VARCHAR(16),
  ADD COLUMN "orderUnitSnapshot" VARCHAR(16),
  ADD COLUMN "costUnitSnapshot" VARCHAR(16),
  ADD COLUMN "unitConversionStatusSnapshot" "ProductUnitConversionStatus",
  ADD COLUMN "inventoryUnitsPerPurchaseUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerOrderUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerCostUnitSnapshot" DECIMAL(18,6);

ALTER TABLE "delivery_order_items"
  ADD COLUMN "purchaseUnitSnapshot" VARCHAR(16),
  ADD COLUMN "inventoryUnitSnapshot" VARCHAR(16),
  ADD COLUMN "orderUnitSnapshot" VARCHAR(16),
  ADD COLUMN "costUnitSnapshot" VARCHAR(16),
  ADD COLUMN "unitConversionStatusSnapshot" "ProductUnitConversionStatus",
  ADD COLUMN "inventoryUnitsPerPurchaseUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerOrderUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerCostUnitSnapshot" DECIMAL(18,6);

ALTER TABLE "receipt_items"
  ADD COLUMN "purchaseUnitSnapshot" VARCHAR(16),
  ADD COLUMN "orderUnitSnapshot" VARCHAR(16),
  ADD COLUMN "costUnitSnapshot" VARCHAR(16),
  ADD COLUMN "unitConversionStatusSnapshot" "ProductUnitConversionStatus",
  ADD COLUMN "inventoryUnitsPerOrderUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerCostUnitSnapshot" DECIMAL(18,6);
