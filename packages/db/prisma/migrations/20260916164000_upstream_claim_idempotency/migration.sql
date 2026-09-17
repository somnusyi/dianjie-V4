-- 收货后补报属于可重试写操作；客户端重试必须命中同一差异单，不能重复扣款或报损。
ALTER TABLE "upstream_arrival_claims"
ADD COLUMN "idempotencyKey" VARCHAR(160);

CREATE UNIQUE INDEX "upstream_arrival_claims_tenantId_idempotencyKey_key"
ON "upstream_arrival_claims"("tenantId", "idempotencyKey");
