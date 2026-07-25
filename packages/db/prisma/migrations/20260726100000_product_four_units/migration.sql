-- V5 phase 1: product master-data four-unit contract only.
-- Order, delivery, receipt and inventory-document snapshots remain unchanged
-- and belong to the next phase.

ALTER TABLE "products"
  ADD COLUMN "purchaseUnit" VARCHAR(16),
  ADD COLUMN "orderUnit" VARCHAR(16),
  ADD COLUMN "costUnit" VARCHAR(16),
  ADD COLUMN "inventoryUnitsPerOrderUnit" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitsPerCostUnit" DECIMAL(18,6);

-- Deterministic compatibility only: do not inspect specification text or infer
-- historical business relationships.
UPDATE "products"
SET
  "purchaseUnit" = "unit",
  "orderUnit" = "unit",
  "costUnit" = "unit",
  "inventoryUnitsPerOrderUnit" = COALESCE("inventoryUnitsPerPurchaseUnit", 1),
  "inventoryUnitsPerCostUnit" = COALESCE("inventoryUnitsPerPurchaseUnit", 1);

ALTER TABLE "products"
  ALTER COLUMN "purchaseUnit" SET DEFAULT 'kg',
  ALTER COLUMN "purchaseUnit" SET NOT NULL,
  ALTER COLUMN "orderUnit" SET DEFAULT 'kg',
  ALTER COLUMN "orderUnit" SET NOT NULL,
  ALTER COLUMN "costUnit" SET DEFAULT 'kg',
  ALTER COLUMN "costUnit" SET NOT NULL,
  ALTER COLUMN "inventoryUnitsPerOrderUnit" SET DEFAULT 1,
  ALTER COLUMN "inventoryUnitsPerOrderUnit" SET NOT NULL,
  ALTER COLUMN "inventoryUnitsPerCostUnit" SET DEFAULT 1,
  ALTER COLUMN "inventoryUnitsPerCostUnit" SET NOT NULL;

ALTER TABLE "products"
  ADD CONSTRAINT "products_four_unit_names_ck"
  CHECK (
    length(btrim("purchaseUnit")) > 0
    AND length(btrim("orderUnit")) > 0
    AND length(btrim("costUnit")) > 0
  ),
  ADD CONSTRAINT "products_order_unit_factor_ck"
  CHECK (
    "inventoryUnitsPerOrderUnit" > 0
    AND "inventoryUnitsPerOrderUnit" <= 999999999999.999999
  ),
  ADD CONSTRAINT "products_cost_unit_factor_ck"
  CHECK (
    "inventoryUnitsPerCostUnit" > 0
    AND "inventoryUnitsPerCostUnit" <= 999999999999.999999
  ),
  ADD CONSTRAINT "products_four_unit_identity_ck"
  CHECK (
    (
      "inventoryUnit" IS NULL
      OR (
        ("purchaseUnit" <> "inventoryUnit" OR "inventoryUnitsPerPurchaseUnit" = 1)
        AND ("orderUnit" <> "inventoryUnit" OR "inventoryUnitsPerOrderUnit" = 1)
        AND ("costUnit" <> "inventoryUnit" OR "inventoryUnitsPerCostUnit" = 1)
      )
    )
    AND ("purchaseUnit" <> "orderUnit" OR "inventoryUnitsPerPurchaseUnit" = "inventoryUnitsPerOrderUnit")
    AND ("purchaseUnit" <> "costUnit" OR "inventoryUnitsPerPurchaseUnit" = "inventoryUnitsPerCostUnit")
    AND ("orderUnit" <> "costUnit" OR "inventoryUnitsPerOrderUnit" = "inventoryUnitsPerCostUnit")
  );

-- Preserve the nullable-pair semantics of the existing purchase mapping while
-- excluding PostgreSQL numeric NaN/Infinity values.
ALTER TABLE "products"
  DROP CONSTRAINT "products_inventory_units_factor_ck",
  ADD CONSTRAINT "products_inventory_units_factor_ck"
  CHECK (
    ("inventoryUnit" IS NULL AND "inventoryUnitsPerPurchaseUnit" IS NULL)
    OR
    (
      length(btrim("inventoryUnit")) > 0
      AND "inventoryUnitsPerPurchaseUnit" > 0
      AND "inventoryUnitsPerPurchaseUnit" <= 999999999999.999999
    )
  );
