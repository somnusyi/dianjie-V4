CREATE TYPE "SupplierEvidenceDocumentType" AS ENUM ('BUSINESS_LICENSE', 'QUARANTINE_CERTIFICATE');

CREATE TABLE "supplier_evidence_documents" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "type" "SupplierEvidenceDocumentType" NOT NULL,
  "version" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "note" VARCHAR(1000),
  "validFrom" DATE,
  "validUntil" DATE,
  "objectKey" VARCHAR(1024) NOT NULL,
  "fileName" VARCHAR(255) NOT NULL,
  "fileMime" VARCHAR(120) NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdById" VARCHAR(64) NOT NULL,
  "createdByNameSnapshot" VARCHAR(120) NOT NULL,
  "createdByRoleSnapshot" VARCHAR(40) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "archivedById" VARCHAR(64),
  "archivedByNameSnapshot" VARCHAR(120),
  "archivedByRoleSnapshot" VARCHAR(40),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_evidence_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_evidence_documents_version_check" CHECK ("version" > 0),
  CONSTRAINT "supplier_evidence_documents_file_size_check" CHECK ("fileSize" > 0),
  CONSTRAINT "supplier_evidence_documents_validity_check" CHECK (
    "validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil"
  ),
  CONSTRAINT "supplier_evidence_documents_archive_audit_check" CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "archivedByNameSnapshot" IS NULL AND "archivedByRoleSnapshot" IS NULL)
    OR
    ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archivedByNameSnapshot" IS NOT NULL AND "archivedByRoleSnapshot" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "supplier_evidence_documents_tenantId_id_key"
  ON "supplier_evidence_documents"("tenantId", "id");
CREATE UNIQUE INDEX "supplier_evidence_documents_tenantId_requestKey_key"
  ON "supplier_evidence_documents"("tenantId", "requestKey");
CREATE UNIQUE INDEX "supplier_evidence_documents_scope_version_key"
  ON "supplier_evidence_documents"("tenantId", "supplierId", "type", "version");
CREATE INDEX "supplier_evidence_documents_scope_archive_created_idx"
  ON "supplier_evidence_documents"("tenantId", "supplierId", "type", "archivedAt", "createdAt");

ALTER TABLE "supplier_evidence_documents" ADD CONSTRAINT "supplier_evidence_documents_tenant_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_evidence_documents" ADD CONSTRAINT "supplier_evidence_documents_supplier_fkey"
  FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_evidence_documents" ADD CONSTRAINT "supplier_evidence_documents_created_by_fkey"
  FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_evidence_documents" ADD CONSTRAINT "supplier_evidence_documents_archived_by_fkey"
  FOREIGN KEY ("tenantId", "archivedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "supplier_evidence_document_products" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "documentId" VARCHAR(64) NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_evidence_document_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_evidence_document_products_document_product_key"
  ON "supplier_evidence_document_products"("documentId", "productId");
CREATE UNIQUE INDEX "supplier_evidence_document_products_tenantId_id_key"
  ON "supplier_evidence_document_products"("tenantId", "id");
CREATE INDEX "supplier_evidence_document_products_tenant_product_created_idx"
  ON "supplier_evidence_document_products"("tenantId", "productId", "createdAt");

ALTER TABLE "supplier_evidence_document_products" ADD CONSTRAINT "supplier_evidence_document_products_tenant_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_evidence_document_products" ADD CONSTRAINT "supplier_evidence_document_products_document_fkey"
  FOREIGN KEY ("tenantId", "documentId") REFERENCES "supplier_evidence_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_evidence_document_products" ADD CONSTRAINT "supplier_evidence_document_products_product_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "upstream_receipt_line_evidence_documents" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "receiptLineId" VARCHAR(64) NOT NULL,
  "documentId" VARCHAR(64) NOT NULL,
  "linkedById" VARCHAR(64) NOT NULL,
  "linkedByNameSnapshot" VARCHAR(120) NOT NULL,
  "linkedByRoleSnapshot" VARCHAR(40) NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidedById" VARCHAR(64),
  "voidedByNameSnapshot" VARCHAR(120),
  "voidedByRoleSnapshot" VARCHAR(40),
  "voidReason" VARCHAR(500),
  CONSTRAINT "upstream_receipt_line_evidence_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upstream_receipt_line_evidence_documents_void_audit_check" CHECK (
    ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidedByNameSnapshot" IS NULL AND "voidedByRoleSnapshot" IS NULL AND "voidReason" IS NULL)
    OR
    ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidedByNameSnapshot" IS NOT NULL AND "voidedByRoleSnapshot" IS NOT NULL AND "voidReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "upstream_receipt_line_evidence_documents_line_document_key"
  ON "upstream_receipt_line_evidence_documents"("receiptLineId", "documentId");
CREATE UNIQUE INDEX "upstream_receipt_line_evidence_documents_tenantId_id_key"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "id");
CREATE INDEX "upstream_receipt_line_evidence_documents_document_void_linked_idx"
  ON "upstream_receipt_line_evidence_documents"("tenantId", "documentId", "voidedAt", "linkedAt");

ALTER TABLE "upstream_receipt_line_evidence_documents" ADD CONSTRAINT "upstream_receipt_line_evidence_documents_tenant_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upstream_receipt_line_evidence_documents" ADD CONSTRAINT "upstream_receipt_line_evidence_documents_receipt_line_fkey"
  FOREIGN KEY ("tenantId", "receiptLineId") REFERENCES "upstream_receipt_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upstream_receipt_line_evidence_documents" ADD CONSTRAINT "upstream_receipt_line_evidence_documents_document_fkey"
  FOREIGN KEY ("tenantId", "documentId") REFERENCES "supplier_evidence_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upstream_receipt_line_evidence_documents" ADD CONSTRAINT "upstream_receipt_line_evidence_documents_linked_by_fkey"
  FOREIGN KEY ("tenantId", "linkedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upstream_receipt_line_evidence_documents" ADD CONSTRAINT "upstream_receipt_line_evidence_documents_voided_by_fkey"
  FOREIGN KEY ("tenantId", "voidedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
