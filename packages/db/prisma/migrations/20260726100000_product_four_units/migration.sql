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
  "purchaseUnit" = CASE
    WHEN "inventoryUnit" IS NULL OR "inventoryUnitsPerPurchaseUnit" IS NOT NULL THEN "unit"
    ELSE NULL
  END,
  "orderUnit" = CASE
    WHEN "inventoryUnit" IS NULL OR "inventoryUnitsPerPurchaseUnit" IS NOT NULL THEN "unit"
    ELSE NULL
  END,
  "costUnit" = CASE
    WHEN "inventoryUnit" IS NULL OR "inventoryUnitsPerPurchaseUnit" IS NOT NULL THEN "unit"
    ELSE NULL
  END,
  "inventoryUnitsPerOrderUnit" = CASE
    WHEN "inventoryUnit" IS NULL THEN 1
    ELSE "inventoryUnitsPerPurchaseUnit"
  END,
  "inventoryUnitsPerCostUnit" = CASE
    WHEN "inventoryUnit" IS NULL THEN 1
    ELSE "inventoryUnitsPerPurchaseUnit"
  END,
  "inventoryUnit" = COALESCE("inventoryUnit", "unit"),
  "inventoryUnitsPerPurchaseUnit" = CASE
    WHEN "inventoryUnit" IS NULL THEN 1
    ELSE "inventoryUnitsPerPurchaseUnit"
  END;

-- Keep the new columns nullable for old services and one-off test fixtures that
-- still create products directly through Prisma with only the legacy unit and
-- purchase-to-inventory mapping. The V5 API always writes all four fields;
-- readers use deterministic legacy fallback when a direct legacy write leaves
-- the new fields null.

ALTER TABLE "products"
  ADD CONSTRAINT "products_four_unit_names_ck"
  CHECK (
    (
      "purchaseUnit" IS NULL
      AND "orderUnit" IS NULL
      AND "costUnit" IS NULL
      AND "inventoryUnitsPerOrderUnit" IS NULL
      AND "inventoryUnitsPerCostUnit" IS NULL
    )
    OR
    (
      length(btrim("purchaseUnit")) > 0
      AND length(btrim("orderUnit")) > 0
      AND length(btrim("costUnit")) > 0
      AND "inventoryUnit" IS NOT NULL
      AND "inventoryUnitsPerPurchaseUnit" IS NOT NULL
      AND "inventoryUnitsPerOrderUnit" IS NOT NULL
      AND "inventoryUnitsPerCostUnit" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "products_order_unit_factor_ck"
  CHECK (
    "inventoryUnitsPerOrderUnit" IS NULL
    OR (
      "inventoryUnitsPerOrderUnit" > 0
      AND "inventoryUnitsPerOrderUnit" <= 999999999999.999999
    )
  ),
  ADD CONSTRAINT "products_cost_unit_factor_ck"
  CHECK (
    "inventoryUnitsPerCostUnit" IS NULL
    OR (
      "inventoryUnitsPerCostUnit" > 0
      AND "inventoryUnitsPerCostUnit" <= 999999999999.999999
    )
  ),
  ADD CONSTRAINT "products_four_unit_identity_ck"
  CHECK (
    "purchaseUnit" IS NULL
    OR (
        ("purchaseUnit" <> "inventoryUnit" OR "inventoryUnitsPerPurchaseUnit" = 1)
        AND ("orderUnit" <> "inventoryUnit" OR "inventoryUnitsPerOrderUnit" = 1)
        AND ("costUnit" <> "inventoryUnit" OR "inventoryUnitsPerCostUnit" = 1)
        AND ("purchaseUnit" <> "orderUnit" OR "inventoryUnitsPerPurchaseUnit" = "inventoryUnitsPerOrderUnit")
        AND ("purchaseUnit" <> "costUnit" OR "inventoryUnitsPerPurchaseUnit" = "inventoryUnitsPerCostUnit")
        AND ("orderUnit" <> "costUnit" OR "inventoryUnitsPerOrderUnit" = "inventoryUnitsPerCostUnit")
    )
  );

-- A named inventory unit with no factor remains a safe PENDING legacy mapping;
-- do not invent a package relationship. Complete V5 rows are made strict by
-- products_four_unit_names_ck above.
ALTER TABLE "products"
  DROP CONSTRAINT "products_inventory_units_factor_ck",
  ADD CONSTRAINT "products_inventory_units_factor_ck"
  CHECK (
    ("inventoryUnit" IS NULL AND "inventoryUnitsPerPurchaseUnit" IS NULL)
    OR
    (
      "inventoryUnit" IS NOT NULL
      AND length(btrim("inventoryUnit")) > 0
      AND (
        "inventoryUnitsPerPurchaseUnit" IS NULL
        OR (
          "inventoryUnitsPerPurchaseUnit" > 0
          AND "inventoryUnitsPerPurchaseUnit" <= 999999999999.999999
        )
      )
    )
  );
