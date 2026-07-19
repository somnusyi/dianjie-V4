CREATE TYPE "SupplierInventoryMode" AS ENUM ('NOT_TRACKED', 'STRICT');

ALTER TABLE "suppliers"
  ADD COLUMN "inventoryMode" "SupplierInventoryMode" NOT NULL DEFAULT 'NOT_TRACKED',
  ADD COLUMN "inventoryActivatedAt" TIMESTAMP(3);

COMMENT ON COLUMN "suppliers"."inventoryMode" IS
  'NOT_TRACKED: supplier warehouse stock is not enforced; STRICT: reserve and consume supplier stock during fulfillment';
