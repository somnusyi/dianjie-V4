-- Keep purchase-return supplier references inside the authenticated tenant at
-- the database boundary, not only in the service layer.
CREATE UNIQUE INDEX "suppliers_tenantId_id_key" ON "suppliers"("tenantId", "id");

ALTER TABLE "upstream_purchase_returns"
  DROP CONSTRAINT "upstream_purchase_returns_supplierId_fkey";

ALTER TABLE "upstream_purchase_returns"
  ADD CONSTRAINT "upstream_purchase_returns_tenantId_supplierId_fkey"
  FOREIGN KEY ("tenantId", "supplierId")
  REFERENCES "suppliers"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
