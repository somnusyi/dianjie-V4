-- 合同草稿创建需要在 Redis 不可用时仍可持久防重，且拒绝同一键重放不同内容。
ALTER TABLE "upstream_supplier_contracts"
  ADD COLUMN "idempotencyKey" VARCHAR(160),
  ADD COLUMN "requestFingerprint" CHAR(64);

CREATE UNIQUE INDEX "upstream_supplier_contracts_tenantId_idempotencyKey_key"
  ON "upstream_supplier_contracts"("tenantId", "idempotencyKey");
