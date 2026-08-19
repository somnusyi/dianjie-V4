-- P2 入库结构化：
-- 1) 台账挂供应商（保留 sourceName 兼容历史；数据包多供应商聚合行保持 null）
-- 2) 供应商名称别名表（美团包/历史文本 → 供应商主数据，认领一次永久命中）
ALTER TABLE "warehouse_ledger_movements" ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
ALTER TABLE "warehouse_ledger_movements"
  ADD CONSTRAINT "warehouse_ledger_movements_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "warehouse_ledger_movements_tenantId_supplierId_effectiveAt_idx"
  ON "warehouse_ledger_movements"("tenantId", "supplierId", "effectiveAt");

CREATE TABLE IF NOT EXISTS "supplier_name_aliases" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "supplierId"  TEXT NOT NULL,
  "alias"       VARCHAR(120) NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_name_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_name_aliases_tenantId_alias_key"
  ON "supplier_name_aliases"("tenantId", "alias");
CREATE INDEX IF NOT EXISTS "supplier_name_aliases_tenantId_supplierId_idx"
  ON "supplier_name_aliases"("tenantId", "supplierId");
ALTER TABLE "supplier_name_aliases"
  ADD CONSTRAINT "supplier_name_aliases_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_name_aliases"
  ADD CONSTRAINT "supplier_name_aliases_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
