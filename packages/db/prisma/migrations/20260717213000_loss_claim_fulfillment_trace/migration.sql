-- Separate supplier arrival discrepancies from store-internal waste and make
-- every new arrival discrepancy traceable to the exact fulfillment document.
CREATE TYPE "LossClaimKind" AS ENUM (
  'ARRIVAL_SHORTAGE',
  'ARRIVAL_DAMAGE',
  'INTERNAL_WASTE',
  'LEGACY_UNRESOLVED'
);

ALTER TABLE "loss_claims"
  ADD COLUMN "kind" "LossClaimKind" NOT NULL DEFAULT 'LEGACY_UNRESOLVED',
  ADD COLUMN "deliveryOrderId" TEXT,
  ADD COLUMN "receiptId" TEXT;

ALTER TABLE "loss_claim_items"
  ADD COLUMN "deliveryOrderItemId" TEXT;

-- isManual is the one historical signal that is authoritative. Historical
-- supplier claims remain LEGACY_UNRESOLVED rather than guessing a delivery.
UPDATE "loss_claims"
SET "kind" = 'INTERNAL_WASTE'
WHERE "isManual" = TRUE;

ALTER TABLE "loss_claims"
  ADD CONSTRAINT "loss_claims_deliveryOrderId_fkey"
  FOREIGN KEY ("deliveryOrderId") REFERENCES "delivery_orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "loss_claims_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "loss_claim_items"
  ADD CONSTRAINT "loss_claim_items_deliveryOrderItemId_fkey"
  FOREIGN KEY ("deliveryOrderItemId") REFERENCES "delivery_order_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "loss_claims_deliveryOrderId_idx" ON "loss_claims"("deliveryOrderId");
CREATE INDEX "loss_claims_receiptId_idx" ON "loss_claims"("receiptId");
CREATE INDEX "loss_claims_tenantId_kind_createdAt_idx" ON "loss_claims"("tenantId", "kind", "createdAt");
CREATE INDEX "loss_claim_items_deliveryOrderItemId_idx" ON "loss_claim_items"("deliveryOrderItemId");
