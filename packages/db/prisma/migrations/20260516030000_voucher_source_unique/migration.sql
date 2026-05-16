-- P0: sourceType+sourceId 在 tenant 内唯一, 防并发重复建凭证
-- PostgreSQL 对 (NULL, NULL) 默认允许多行 (NULLs distinct), 所以无 source 的凭证不受影响
CREATE UNIQUE INDEX "vouchers_tenantId_sourceType_sourceId_key"
  ON "vouchers"("tenantId", "sourceType", "sourceId");

-- 删掉原有非 unique 索引 (重复)
DROP INDEX IF EXISTS "vouchers_tenantId_sourceType_sourceId_idx";
