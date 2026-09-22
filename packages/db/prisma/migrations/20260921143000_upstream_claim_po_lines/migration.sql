-- 补报异常要能覆盖原采购单中尚未形成收货行的商品。
-- 已收货商品仍保留 receiptLineId；少发商品可只引用采购单行。
ALTER TABLE "upstream_arrival_claim_lines"
  DROP CONSTRAINT "upstream_arrival_claim_lines_tenantId_receiptLineId_fkey";

ALTER TABLE "upstream_arrival_claim_lines"
  ALTER COLUMN "receiptLineId" DROP NOT NULL;

DROP INDEX "upstream_arrival_claim_lines_claimId_receiptLineId_key";

CREATE UNIQUE INDEX "upstream_arrival_claim_lines_claimId_purchaseOrderLineId_key"
  ON "upstream_arrival_claim_lines"("claimId", "purchaseOrderLineId");

ALTER TABLE "upstream_arrival_claim_lines"
  ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_receiptLineId_fkey"
  FOREIGN KEY ("tenantId", "receiptLineId")
  REFERENCES "upstream_receipt_lines"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loss_claim_items"
  ADD COLUMN "reason" VARCHAR(30);
