-- 仓库单据层（审核流，2026-08-24）：
-- 台账只增不改；单据是控制层（制单即过账，会计审核锁定，反审核后可改）。
-- 金额修改走 ADJUSTMENT 差额流水；reviewStatus 预留复审层。
DO $$ BEGIN
  CREATE TYPE "WarehouseDocType" AS ENUM ('MANUAL_INBOUND', 'MANUAL_OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "WarehouseDocStatus" AS ENUM ('POSTED', 'CONFIRMED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "WarehouseDocReviewStatus" AS ENUM ('UNREVIEWED', 'REVIEWED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "WarehouseDocLogAction" AS ENUM ('CREATE', 'CONFIRM', 'UNCONFIRM', 'EDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "warehouse_docs" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "docNo"          VARCHAR(40) NOT NULL,
  "type"           "WarehouseDocType" NOT NULL,
  "warehouseId"    VARCHAR(64) NOT NULL,
  "supplierId"     TEXT,
  "supplierName"   VARCHAR(120),
  "reason"         VARCHAR(120),
  "note"           VARCHAR(240),
  "effectiveAt"    TIMESTAMP(3) NOT NULL,
  "status"         "WarehouseDocStatus" NOT NULL DEFAULT 'POSTED',
  "reviewStatus"   "WarehouseDocReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  "lineCount"      INTEGER NOT NULL DEFAULT 0,
  "totalAmount"    DECIMAL(20, 4) NOT NULL DEFAULT 0,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "confirmedById"  TEXT,
  "confirmedAt"    TIMESTAMP(3),
  "unauditedById"  TEXT,
  "unauditedAt"    TIMESTAMP(3),
  "unauditReason"  VARCHAR(240),
  CONSTRAINT "warehouse_docs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_docs_tenantId_docNo_key"
  ON "warehouse_docs"("tenantId", "docNo");
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_docs_tenantId_type_idempotencyKey_key"
  ON "warehouse_docs"("tenantId", "type", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "warehouse_docs_tenantId_type_status_effectiveAt_idx"
  ON "warehouse_docs"("tenantId", "type", "status", "effectiveAt");
CREATE INDEX IF NOT EXISTS "warehouse_docs_tenantId_supplierId_effectiveAt_idx"
  ON "warehouse_docs"("tenantId", "supplierId", "effectiveAt");

CREATE TABLE IF NOT EXISTS "warehouse_doc_lines" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "docId"             TEXT NOT NULL,
  "lineNo"            INTEGER NOT NULL,
  "productId"         TEXT NOT NULL,
  "productName"       VARCHAR(120) NOT NULL,
  "quantity"          DECIMAL(18, 6) NOT NULL,
  "unit"              VARCHAR(16) NOT NULL,
  "unitPrice"         DECIMAL(18, 6),
  "amount"            DECIMAL(20, 4) NOT NULL,
  "inventoryQuantity" DECIMAL(18, 6) NOT NULL,
  "inventoryUnit"     VARCHAR(16) NOT NULL,
  "note"              VARCHAR(240),
  "batchNo"           VARCHAR(80),
  "manufactureDate"   DATE,
  "expiryDate"        DATE,
  "movementId"        VARCHAR(64),
  CONSTRAINT "warehouse_doc_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_doc_lines_docId_lineNo_key"
  ON "warehouse_doc_lines"("docId", "lineNo");
CREATE INDEX IF NOT EXISTS "warehouse_doc_lines_tenantId_productId_idx"
  ON "warehouse_doc_lines"("tenantId", "productId");
CREATE INDEX IF NOT EXISTS "warehouse_doc_lines_movementId_idx"
  ON "warehouse_doc_lines"("movementId");
DO $$ BEGIN
  ALTER TABLE "warehouse_doc_lines"
    ADD CONSTRAINT "warehouse_doc_lines_docId_fkey"
    FOREIGN KEY ("docId") REFERENCES "warehouse_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "warehouse_doc_lines"
    ADD CONSTRAINT "warehouse_doc_lines_movementId_fkey"
    FOREIGN KEY ("movementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "warehouse_doc_logs" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "docId"     TEXT NOT NULL,
  "action"    "WarehouseDocLogAction" NOT NULL,
  "actorId"   TEXT,
  "actorName" VARCHAR(120),
  "reason"    VARCHAR(240),
  "detail"    JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_doc_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "warehouse_doc_logs_tenantId_docId_createdAt_idx"
  ON "warehouse_doc_logs"("tenantId", "docId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "warehouse_doc_logs"
    ADD CONSTRAINT "warehouse_doc_logs_docId_fkey"
    FOREIGN KEY ("docId") REFERENCES "warehouse_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
