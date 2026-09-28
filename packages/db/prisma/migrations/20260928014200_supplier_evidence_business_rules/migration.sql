ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'INSPECTION_REPORT';
ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'SLAUGHTER_CERTIFICATE';
ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'PRODUCTION_INSPECTION_REPORT';
ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'THIRD_PARTY_TEST_REPORT';
ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'PESTICIDE_RESIDUE_REPORT';
ALTER TYPE "SupplierEvidenceDocumentType" ADD VALUE IF NOT EXISTS 'OTHER_PRODUCT_EVIDENCE';

CREATE TYPE "ProductEvidenceRequirement" AS ENUM ('PENDING', 'REQUIRED', 'NOT_REQUIRED');

ALTER TABLE "products"
  ADD COLUMN "evidenceRequirement" "ProductEvidenceRequirement" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "evidenceRequirementVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "product_evidence_requirement_changes" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "beforeStatus" "ProductEvidenceRequirement" NOT NULL,
  "afterStatus" "ProductEvidenceRequirement" NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "newVersion" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdById" VARCHAR(64) NOT NULL,
  "createdByNameSnapshot" VARCHAR(120) NOT NULL,
  "createdByRoleSnapshot" VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_evidence_requirement_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_evidence_requirement_changes_version_check" CHECK (
    "expectedVersion" >= 0 AND "newVersion" = "expectedVersion" + 1
  )
);
CREATE UNIQUE INDEX "product_evidence_requirement_changes_tenant_id_key"
  ON "product_evidence_requirement_changes"("tenantId", "id");
CREATE UNIQUE INDEX "product_evidence_requirement_changes_request_key"
  ON "product_evidence_requirement_changes"("tenantId", "requestKey");
CREATE INDEX "product_evidence_requirement_changes_product_created_idx"
  ON "product_evidence_requirement_changes"("tenantId", "productId", "createdAt");
ALTER TABLE "product_evidence_requirement_changes" ADD CONSTRAINT "product_evidence_requirement_changes_product_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_evidence_requirement_changes" ADD CONSTRAINT "product_evidence_requirement_changes_actor_fkey"
  FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "upstream_receipts"
  ADD COLUMN "evidenceCompletenessSnapshot" JSONB;

ALTER TABLE "upstream_receipt_line_evidence_documents"
  ADD COLUMN "linkedAfterPosted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "backfillReason" VARCHAR(500);

ALTER TABLE "upstream_receipt_line_evidence_documents"
  ADD CONSTRAINT "upstream_receipt_line_evidence_documents_backfill_check" CHECK (
    ("linkedAfterPosted" = false AND "backfillReason" IS NULL)
    OR
    ("linkedAfterPosted" = true AND length(trim("backfillReason")) > 0)
  );
