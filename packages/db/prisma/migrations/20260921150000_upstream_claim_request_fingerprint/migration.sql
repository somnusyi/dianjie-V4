-- 幂等键只能重放完全相同的补报内容；差异单本身的说明/证据会在后续处理中变更，
-- 因此单独保存不可变的原始请求指纹。
ALTER TABLE "upstream_arrival_claims"
  ADD COLUMN "requestFingerprint" CHAR(64);
