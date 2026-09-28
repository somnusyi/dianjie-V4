ALTER TYPE "UpstreamReceiptReviewReason" ADD VALUE IF NOT EXISTS 'ABOVE_STANDARD_PRICE';
CREATE TYPE "UpstreamQualityResult" AS ENUM ('PASS', 'FAIL');

CREATE TABLE "product_quality_standards" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "criteria" JSONB NOT NULL,
  "effectiveAt" DATE NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" VARCHAR(64) NOT NULL,
  "createdByNameSnapshot" VARCHAR(120) NOT NULL,
  "createdByRoleSnapshot" VARCHAR(40) NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "archivedById" VARCHAR(64),
  "archivedByNameSnapshot" VARCHAR(120),
  "archivedByRoleSnapshot" VARCHAR(40),
  "archiveRequestKey" VARCHAR(160),
  "archiveRequestFingerprint" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_quality_standards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_quality_standards_tenantId_id_key" ON "product_quality_standards"("tenantId", "id");
CREATE UNIQUE INDEX "product_quality_standards_tenantId_productId_version_key" ON "product_quality_standards"("tenantId", "productId", "version");
CREATE UNIQUE INDEX "product_quality_standards_tenantId_requestKey_key" ON "product_quality_standards"("tenantId", "requestKey");
CREATE UNIQUE INDEX "product_quality_standards_tenantId_archiveRequestKey_key" ON "product_quality_standards"("tenantId", "archiveRequestKey");
CREATE INDEX "product_quality_standards_tenantId_productId_active_effectiveAt_idx" ON "product_quality_standards"("tenantId", "productId", "active", "effectiveAt");
CREATE UNIQUE INDEX "product_quality_standards_one_active_scope_key" ON "product_quality_standards"("tenantId", "productId") WHERE "active" = true;
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_tenantId_archivedById_fkey" FOREIGN KEY ("tenantId", "archivedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_archive_complete_check" CHECK (
  ("active" = true AND "archivedAt" IS NULL AND "archivedById" IS NULL AND "archivedByNameSnapshot" IS NULL AND "archivedByRoleSnapshot" IS NULL AND "archiveRequestKey" IS NULL AND "archiveRequestFingerprint" IS NULL)
  OR
  ("active" = false AND "archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archivedByNameSnapshot" IS NOT NULL AND "archivedByRoleSnapshot" IS NOT NULL AND "archiveRequestKey" IS NOT NULL AND "archiveRequestFingerprint" IS NOT NULL)
);
ALTER TABLE "product_quality_standards" ADD CONSTRAINT "product_quality_standards_version_check" CHECK ("version" > 0);

CREATE TABLE "product_purchase_price_standards" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "purchaseUnit" VARCHAR(16) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "taxInclusive" BOOLEAN NOT NULL,
  "unitPrice" DECIMAL(18,6) NOT NULL,
  "effectiveAt" DATE NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" VARCHAR(64) NOT NULL,
  "createdByNameSnapshot" VARCHAR(120) NOT NULL,
  "createdByRoleSnapshot" VARCHAR(40) NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "archivedById" VARCHAR(64),
  "archivedByNameSnapshot" VARCHAR(120),
  "archivedByRoleSnapshot" VARCHAR(40),
  "archiveRequestKey" VARCHAR(160),
  "archiveRequestFingerprint" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_purchase_price_standards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_purchase_price_standards_unit_price_check" CHECK ("unitPrice" > 0),
  CONSTRAINT "product_purchase_price_standards_archive_complete_check" CHECK (
    ("active" = true AND "archivedAt" IS NULL AND "archivedById" IS NULL AND "archivedByNameSnapshot" IS NULL AND "archivedByRoleSnapshot" IS NULL AND "archiveRequestKey" IS NULL AND "archiveRequestFingerprint" IS NULL)
    OR
    ("active" = false AND "archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archivedByNameSnapshot" IS NOT NULL AND "archivedByRoleSnapshot" IS NOT NULL AND "archiveRequestKey" IS NOT NULL AND "archiveRequestFingerprint" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "product_purchase_price_standards_tenantId_id_key" ON "product_purchase_price_standards"("tenantId", "id");
CREATE UNIQUE INDEX "product_purchase_price_standards_scope_version_key" ON "product_purchase_price_standards"("tenantId", "productId", "supplierId", "purchaseUnit", "currency", "taxInclusive", "version");
CREATE UNIQUE INDEX "product_purchase_price_standards_tenantId_requestKey_key" ON "product_purchase_price_standards"("tenantId", "requestKey");
CREATE UNIQUE INDEX "product_purchase_price_standards_tenantId_archiveRequestKey_key" ON "product_purchase_price_standards"("tenantId", "archiveRequestKey");
CREATE INDEX "product_purchase_price_standards_scope_active_idx" ON "product_purchase_price_standards"("tenantId", "productId", "supplierId", "purchaseUnit", "active", "effectiveAt");
CREATE UNIQUE INDEX "product_purchase_price_standards_one_active_scope_key" ON "product_purchase_price_standards"("tenantId", "productId", "supplierId", "purchaseUnit", "currency", "taxInclusive") WHERE "active" = true;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_supplier_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_created_by_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_archived_by_fkey" FOREIGN KEY ("tenantId", "archivedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_purchase_price_standards" ADD CONSTRAINT "product_purchase_price_standards_version_check" CHECK ("version" > 0);

ALTER TABLE "upstream_purchase_order_lines"
  ADD COLUMN "standardUnitPriceSnapshot" DECIMAL(18,6),
  ADD COLUMN "priceStandardCurrencySnapshot" VARCHAR(3),
  ADD COLUMN "priceStandardTaxInclusiveSnapshot" BOOLEAN,
  ADD COLUMN "priceStandardId" VARCHAR(64),
  ADD COLUMN "priceStandardVersionSnapshot" INTEGER,
  ADD COLUMN "qualityStandardId" VARCHAR(64),
  ADD COLUMN "qualityStandardVersionSnapshot" INTEGER,
  ADD COLUMN "qualityCriteriaSnapshot" JSONB;
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_tenantId_qualityStandardId_fkey" FOREIGN KEY ("tenantId", "qualityStandardId") REFERENCES "product_quality_standards"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_tenantId_priceStandardId_fkey" FOREIGN KEY ("tenantId", "priceStandardId") REFERENCES "product_purchase_price_standards"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "upstream_purchase_order_lines_tenantId_qualityStandardId_idx" ON "upstream_purchase_order_lines"("tenantId", "qualityStandardId");
CREATE INDEX "upstream_purchase_order_lines_tenantId_priceStandardId_idx" ON "upstream_purchase_order_lines"("tenantId", "priceStandardId");
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_price_standard_snapshot_check" CHECK (
  ("standardUnitPriceSnapshot" IS NULL AND "priceStandardCurrencySnapshot" IS NULL AND "priceStandardTaxInclusiveSnapshot" IS NULL AND "priceStandardId" IS NULL AND "priceStandardVersionSnapshot" IS NULL)
  OR
  ("standardUnitPriceSnapshot" > 0 AND "priceStandardCurrencySnapshot" IS NOT NULL AND "priceStandardTaxInclusiveSnapshot" IS NOT NULL AND "priceStandardId" IS NOT NULL AND "priceStandardVersionSnapshot" > 0)
);
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_quality_standard_snapshot_check" CHECK (
  ("qualityStandardId" IS NULL AND "qualityStandardVersionSnapshot" IS NULL AND "qualityCriteriaSnapshot" IS NULL)
  OR
  ("qualityStandardId" IS NOT NULL AND "qualityStandardVersionSnapshot" > 0 AND "qualityCriteriaSnapshot" IS NOT NULL)
);

ALTER TABLE "upstream_receipts"
  ADD COLUMN "requestFingerprint" CHAR(64),
  ADD COLUMN "priceExceptionReason" VARCHAR(500),
  ADD COLUMN "priceExceptionApprovedById" VARCHAR(64),
  ADD COLUMN "priceExceptionApprovedByNameSnapshot" VARCHAR(120),
  ADD COLUMN "priceExceptionApprovedByRoleSnapshot" VARCHAR(40),
  ADD COLUMN "priceExceptionApprovedAt" TIMESTAMP(3);
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_price_exception_complete_check" CHECK (
  ("priceExceptionApprovedAt" IS NULL AND "priceExceptionReason" IS NULL AND "priceExceptionApprovedById" IS NULL AND "priceExceptionApprovedByNameSnapshot" IS NULL AND "priceExceptionApprovedByRoleSnapshot" IS NULL)
  OR
  ("priceExceptionApprovedAt" IS NOT NULL AND "priceExceptionReason" IS NOT NULL AND "priceExceptionApprovedById" IS NOT NULL AND "priceExceptionApprovedByNameSnapshot" IS NOT NULL AND "priceExceptionApprovedByRoleSnapshot" IS NOT NULL)
);
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_tenantId_priceExceptionApprovedById_fkey" FOREIGN KEY ("tenantId", "priceExceptionApprovedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "upstream_receipt_lines"
  ADD COLUMN "standardUnitPriceSnapshot" DECIMAL(18,6),
  ADD COLUMN "priceStandardCurrencySnapshot" VARCHAR(3),
  ADD COLUMN "priceStandardTaxInclusiveSnapshot" BOOLEAN,
  ADD COLUMN "priceStandardId" VARCHAR(64),
  ADD COLUMN "priceStandardVersionSnapshot" INTEGER,
  ADD COLUMN "qualityStandardId" VARCHAR(64),
  ADD COLUMN "qualityStandardVersionSnapshot" INTEGER,
  ADD COLUMN "qualityCriteriaSnapshot" JSONB,
  ADD COLUMN "qualityResult" "UpstreamQualityResult",
  ADD COLUMN "qualityEvidence" JSONB,
  ADD COLUMN "qualityDisposition" VARCHAR(500);
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_qualityStandardId_fkey" FOREIGN KEY ("tenantId", "qualityStandardId") REFERENCES "product_quality_standards"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_priceStandardId_fkey" FOREIGN KEY ("tenantId", "priceStandardId") REFERENCES "product_purchase_price_standards"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "upstream_receipt_lines_tenantId_qualityStandardId_idx" ON "upstream_receipt_lines"("tenantId", "qualityStandardId");
CREATE INDEX "upstream_receipt_lines_tenantId_priceStandardId_idx" ON "upstream_receipt_lines"("tenantId", "priceStandardId");
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_quality_failure_check" CHECK (
  "qualityResult" <> 'FAIL' OR ("acceptedQty" = 0 AND "qualityDisposition" IS NOT NULL AND "qualityEvidence" IS NOT NULL)
);
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_price_standard_snapshot_check" CHECK (
  ("standardUnitPriceSnapshot" IS NULL AND "priceStandardCurrencySnapshot" IS NULL AND "priceStandardTaxInclusiveSnapshot" IS NULL AND "priceStandardId" IS NULL AND "priceStandardVersionSnapshot" IS NULL)
  OR
  ("standardUnitPriceSnapshot" > 0 AND "priceStandardCurrencySnapshot" IS NOT NULL AND "priceStandardTaxInclusiveSnapshot" IS NOT NULL AND "priceStandardId" IS NOT NULL AND "priceStandardVersionSnapshot" > 0)
);
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_quality_standard_snapshot_check" CHECK (
  ("qualityStandardId" IS NULL AND "qualityStandardVersionSnapshot" IS NULL AND "qualityCriteriaSnapshot" IS NULL AND "qualityResult" IS NULL)
  OR
  ("qualityStandardId" IS NOT NULL AND "qualityStandardVersionSnapshot" > 0 AND "qualityCriteriaSnapshot" IS NOT NULL AND "qualityResult" IS NOT NULL)
);
