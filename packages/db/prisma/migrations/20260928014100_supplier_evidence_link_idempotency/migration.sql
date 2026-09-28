DROP INDEX "upstream_receipt_line_evidence_documents_line_document_key";

ALTER TABLE "upstream_receipt_line_evidence_documents"
  ADD COLUMN "linkRequestKey" VARCHAR(160),
  ADD COLUMN "linkRequestFingerprint" CHAR(64),
  ADD COLUMN "voidRequestKey" VARCHAR(160),
  ADD COLUMN "voidRequestFingerprint" CHAR(64);

-- 140 与 141 应同批发布；若140曾短暂独立运行并产生数据，也先为旧关联生成
-- 稳定的兼容幂等身份，再收紧NOT NULL，避免升级失败或抹掉历史。
UPDATE "upstream_receipt_line_evidence_documents"
SET
  "linkRequestKey" = 'legacy:' || "id",
  "linkRequestFingerprint" = repeat('0', 32) || md5("tenantId" || ':' || "receiptLineId" || ':' || "documentId")
WHERE "linkRequestKey" IS NULL OR "linkRequestFingerprint" IS NULL;

ALTER TABLE "upstream_receipt_line_evidence_documents"
  ALTER COLUMN "linkRequestKey" SET NOT NULL,
  ALTER COLUMN "linkRequestFingerprint" SET NOT NULL;

CREATE UNIQUE INDEX "upstream_receipt_line_evidence_documents_active_pair_key"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "receiptLineId", "documentId")
  WHERE "voidedAt" IS NULL;
CREATE UNIQUE INDEX "upstream_receipt_line_evidence_documents_link_request_key"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "linkRequestKey");
CREATE UNIQUE INDEX "upstream_receipt_line_evidence_documents_void_request_key"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "voidRequestKey");
CREATE INDEX "upstream_receipt_line_evidence_documents_line_document_void_idx"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "receiptLineId", "documentId", "voidedAt");

ALTER TABLE "upstream_receipt_line_evidence_documents"
  ADD CONSTRAINT "upstream_receipt_line_evidence_documents_void_request_check" CHECK (
    ("voidedAt" IS NULL AND "voidRequestKey" IS NULL AND "voidRequestFingerprint" IS NULL)
    OR
    ("voidedAt" IS NOT NULL AND "voidRequestKey" IS NOT NULL AND "voidRequestFingerprint" IS NOT NULL)
  );
