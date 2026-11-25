-- Historical transfers have no provable brand and remain backend-only.
ALTER TABLE "store_transfers" ADD COLUMN "brandCode" TEXT;
ALTER TABLE "store_transfers" ADD CONSTRAINT "store_transfers_brandCode_check"
  CHECK ("brandCode" IS NULL OR "brandCode" IN ('DIANJIE', 'LANCANGYAO', 'PAOPAO_ISLAND'));
CREATE INDEX "store_transfers_tenantId_brandCode_idx"
  ON "store_transfers"("tenantId", "brandCode");
