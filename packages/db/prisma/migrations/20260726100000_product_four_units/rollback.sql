-- Manual rollback for 20260726100000_product_four_units.
-- Run only after code using the four-unit columns has been rolled back.

ALTER TABLE "products"
  DROP CONSTRAINT "products_four_unit_names_ck",
  DROP CONSTRAINT "products_order_unit_factor_ck",
  DROP CONSTRAINT "products_cost_unit_factor_ck",
  DROP CONSTRAINT "products_four_unit_identity_ck";

ALTER TABLE "products"
  DROP CONSTRAINT "products_inventory_units_factor_ck",
  ADD CONSTRAINT "products_inventory_units_factor_ck"
  CHECK (
    ("inventoryUnit" IS NULL AND "inventoryUnitsPerPurchaseUnit" IS NULL)
    OR
    (length(btrim("inventoryUnit")) > 0 AND "inventoryUnitsPerPurchaseUnit" > 0)
  );

ALTER TABLE "products"
  DROP COLUMN "inventoryUnitsPerCostUnit",
  DROP COLUMN "inventoryUnitsPerOrderUnit",
  DROP COLUMN "costUnit",
  DROP COLUMN "orderUnit",
  DROP COLUMN "purchaseUnit";
