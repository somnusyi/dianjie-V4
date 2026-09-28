ALTER TABLE "suppliers" ADD COLUMN "address" TEXT;

CREATE TYPE "SupplierArchiveSection" AS ENUM ('QUALIFICATION', 'FINANCE', 'INVOICE');

CREATE TABLE "supplier_archive_records" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "section" "SupplierArchiveSection" NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "note" VARCHAR(1000),
  "validFrom" DATE,
  "validUntil" DATE,
  "objectKey" VARCHAR(1024),
  "fileName" VARCHAR(255),
  "fileMime" VARCHAR(120),
  "fileSize" INTEGER,
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
  CONSTRAINT "supplier_archive_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_archive_records_tenantId_id_key"
  ON "supplier_archive_records"("tenantId", "id");
CREATE UNIQUE INDEX "supplier_archive_records_tenantId_requestKey_key"
  ON "supplier_archive_records"("tenantId", "requestKey");
CREATE INDEX "supplier_archive_records_tenantId_supplierId_section_createdAt_idx"
  ON "supplier_archive_records"("tenantId", "supplierId", "section", "createdAt");

ALTER TABLE "supplier_archive_records"
  ADD CONSTRAINT "supplier_archive_records_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_archive_records"
  ADD CONSTRAINT "supplier_archive_records_tenantId_supplierId_fkey"
  FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_archive_records"
  ADD CONSTRAINT "supplier_archive_records_tenantId_createdById_fkey"
  FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_archive_records"
  ADD CONSTRAINT "supplier_archive_records_tenantId_archivedById_fkey"
  FOREIGN KEY ("tenantId", "archivedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_archive_records" ADD CONSTRAINT "supplier_archive_records_validity_check"
  CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil");
ALTER TABLE "supplier_archive_records" ADD CONSTRAINT "supplier_archive_records_file_metadata_check"
  CHECK (
    ("objectKey" IS NULL AND "fileName" IS NULL AND "fileMime" IS NULL AND "fileSize" IS NULL)
    OR
    ("objectKey" IS NOT NULL AND "fileName" IS NOT NULL AND "fileMime" IS NOT NULL AND "fileSize" IS NOT NULL AND "fileSize" > 0)
  );
ALTER TABLE "supplier_archive_records" ADD CONSTRAINT "supplier_archive_records_archive_audit_check"
  CHECK (
    ("archivedAt" IS NULL AND "archivedById" IS NULL AND "archivedByNameSnapshot" IS NULL AND "archivedByRoleSnapshot" IS NULL)
    OR
    ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archivedByNameSnapshot" IS NOT NULL AND "archivedByRoleSnapshot" IS NOT NULL)
  );
