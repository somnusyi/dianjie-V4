-- Separate upstream warehouse vendors from store-order fulfillment providers
-- while keeping one canonical supplier profile. Existing suppliers preserve
-- their historical store-fulfillment behaviour.
CREATE TYPE "SupplierBusinessScope" AS ENUM (
  'WAREHOUSE_UPSTREAM',
  'STORE_FULFILLER',
  'DIRECT_STORE_VENDOR'
);

ALTER TABLE "suppliers"
  ADD COLUMN "businessScopes" "SupplierBusinessScope"[] NOT NULL
  DEFAULT ARRAY['STORE_FULFILLER']::"SupplierBusinessScope"[];

CREATE INDEX "suppliers_business_scopes_idx"
  ON "suppliers" USING GIN ("businessScopes");
