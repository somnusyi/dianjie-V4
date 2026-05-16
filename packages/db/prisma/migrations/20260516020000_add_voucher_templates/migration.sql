-- 周期性凭证模板
CREATE TABLE "voucher_templates" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "description"   TEXT,
  "frequency"     TEXT NOT NULL DEFAULT 'MONTHLY',
  "dayOfMonth"    INTEGER NOT NULL DEFAULT 1,
  "entriesJson"   JSONB NOT NULL,
  "summary"       TEXT NOT NULL,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt"     TIMESTAMP(3),
  "lastVoucherId" TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voucher_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "voucher_templates_tenantId_enabled_idx" ON "voucher_templates"("tenantId", "enabled");
