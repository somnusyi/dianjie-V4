-- ════════════════════════════════════════════════════════════════════════════
-- Drift cleanup: 让 DB 与 schema.prisma 完全一致
--
-- 背景: 2026-05-19 prisma migrate diff 发现 dev DB 与 schema.prisma 双向漂移.
--   _prisma_migrations 表里有 20260513070259_add_meituan_webhook 但 folder 缺,
--   且该行 applied_steps_count=0 (手动 INSERT 的假 baseline), 说明这些对象是
--   通过 `prisma db push` 或手 SQL 加进 DB 的, 没留 migration 记录.
--
-- 决策 (2026-05-19 用户拍): 全删. 美团 webhook + 营业额渠道两个特性当前代码
-- 零引用 (apps/api/src + apps/web/src + schema.prisma 都 grep 不到), 属死代码.
--
-- 所有语句加 IF EXISTS / IF NOT EXISTS 防御:
--   - dev DB 状态已知, 但生产 RDS 状态未知 (memory SOP 不能 SSH 读)
--   - 部署时本 migration 跑到生产, 若生产没这些对象, IF EXISTS 让它静默跳过
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. 删除 revenue_transactions 表的 FK 约束 ─────────────────────────────
ALTER TABLE IF EXISTS "revenue_transactions"
  DROP CONSTRAINT IF EXISTS "revenue_transactions_storeId_fkey";

ALTER TABLE IF EXISTS "revenue_transactions"
  DROP CONSTRAINT IF EXISTS "revenue_transactions_tenantId_fkey";

-- ─── 2. 删除死表 ─────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "meituan_raw_messages";
DROP TABLE IF EXISTS "revenue_transactions";

-- ─── 3. 删除 stores 表上的死列 (meituan webhook 残留) ───────────────────────
ALTER TABLE IF EXISTS "stores"
  DROP COLUMN IF EXISTS "meituanLastAuthAt",
  DROP COLUMN IF EXISTS "meituanVoucherEnabled";

-- ─── 4. 删除死 enum ──────────────────────────────────────────────────────
DROP TYPE IF EXISTS "MeituanMsgStatus";
DROP TYPE IF EXISTS "RevenueChannel";
DROP TYPE IF EXISTS "RevenueTxStatus";

-- ─── 5. 反向 drift: schema 有但 dev DB 没的列, 补齐 ─────────────────────────
-- 这批是历史上某次 schema 改动没跑 migrate 留下的孤儿, 跟"送达状态"特性相关.
ALTER TABLE IF EXISTS "purchase_order_items"
  ADD COLUMN IF NOT EXISTS "shippedQty" DECIMAL(10,2);

ALTER TABLE IF EXISTS "purchase_orders"
  ADD COLUMN IF NOT EXISTS "deliveredAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deliveredById"  TEXT,
  ADD COLUMN IF NOT EXISTS "deliveredNote"  TEXT;
