-- P1/P2: split purchase units from store inventory/BOM base units and freeze
-- unit/cost snapshots on inventory-affecting documents. All new columns are
-- nullable/defaulted so deployment remains backward compatible while reviewed
-- master-data mappings are applied after this schema migration.

CREATE TYPE "ProductUnitConversionStatus" AS ENUM ('PENDING', 'INFERRED', 'VERIFIED');

ALTER TABLE "products"
  ADD COLUMN "inventoryUnit" VARCHAR(16),
  ADD COLUMN "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6),
  ADD COLUMN "unitConversionStatus" "ProductUnitConversionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "unitConversionNote" VARCHAR(500),
  ADD COLUMN "unitConversionVerifiedAt" TIMESTAMP(3);

ALTER TABLE "receipt_items"
  ADD COLUMN "inventoryQuantity" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitSnapshot" VARCHAR(16),
  ADD COLUMN "inventoryUnitsPerPurchaseUnitSnapshot" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitCostSnapshot" DECIMAL(18,6);

ALTER TABLE "loss_claim_items"
  ADD COLUMN "inventoryQuantity" DECIMAL(18,6),
  ADD COLUMN "inventoryUnitSnapshot" VARCHAR(16),
  ADD COLUMN "inventoryUnitCostSnapshot" DECIMAL(18,6);

ALTER TABLE "stock_consumptions"
  ADD COLUMN "inventoryQuantity" DECIMAL(18,6),
  ADD COLUMN "unitSnapshot" VARCHAR(16),
  ADD COLUMN "inventoryUnitSnapshot" VARCHAR(16),
  ADD COLUMN "unitCostSnapshot" DECIMAL(18,6),
  ADD COLUMN "costAmountSnapshot" DECIMAL(18,4);

ALTER TABLE "products"
  ADD CONSTRAINT "products_inventory_units_factor_ck"
  CHECK (
    ("inventoryUnit" IS NULL AND "inventoryUnitsPerPurchaseUnit" IS NULL)
    OR
    (length(btrim("inventoryUnit")) > 0 AND "inventoryUnitsPerPurchaseUnit" > 0)
  );

ALTER TABLE "receipt_items"
  ADD CONSTRAINT "receipt_items_inventory_quantity_ck"
  CHECK ("inventoryQuantity" IS NULL OR "inventoryQuantity" >= 0);

ALTER TABLE "loss_claim_items"
  ADD CONSTRAINT "loss_claim_items_inventory_quantity_ck"
  CHECK ("inventoryQuantity" IS NULL OR "inventoryQuantity" >= 0);

ALTER TABLE "stock_consumptions"
  ADD CONSTRAINT "stock_consumptions_inventory_quantity_ck"
  CHECK ("inventoryQuantity" IS NULL OR "inventoryQuantity" >= 0);
