-- 既有生产库 schema 对齐（在 20260715101500_reconcile_schema_drift 被 baseline 后执行）
--
-- 预检结论：
-- - purchase_orders.deliveredAt 已是 timestamp(6)，且不存在毫秒以下精度的数据；收敛到 timestamp(3) 不丢失业务时间。
-- - 以下外键对象均已存在；本迁移仅把删除/更新规则与 schema.prisma 对齐。
-- - stock_consumption_source_uk 仅为历史索引名。

ALTER TABLE "dish_recipes" DROP CONSTRAINT IF EXISTS "dish_recipes_dishId_fkey";
ALTER TABLE "dish_recipes" DROP CONSTRAINT IF EXISTS "dish_recipes_productId_fkey";
ALTER TABLE "dish_sales" DROP CONSTRAINT IF EXISTS "dish_sales_dishId_fkey";
ALTER TABLE "dish_sales" DROP CONSTRAINT IF EXISTS "dish_sales_storeId_fkey";
ALTER TABLE "voucher_entries" DROP CONSTRAINT IF EXISTS "voucher_entries_accountFkId_fkey";
ALTER TABLE "voucher_entries" DROP CONSTRAINT IF EXISTS "voucher_entries_voucherId_fkey";

ALTER TABLE "purchase_orders"
  ALTER COLUMN "deliveredAt" SET DATA TYPE TIMESTAMP(3)
  USING "deliveredAt"::timestamp(3);

ALTER TABLE "voucher_entries"
  ADD CONSTRAINT "voucher_entries_voucherId_fkey"
  FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "voucher_entries"
  ADD CONSTRAINT "voucher_entries_accountFkId_fkey"
  FOREIGN KEY ("accountFkId") REFERENCES "chart_of_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "dish_recipes"
  ADD CONSTRAINT "dish_recipes_dishId_fkey"
  FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dish_recipes"
  ADD CONSTRAINT "dish_recipes_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dish_sales"
  ADD CONSTRAINT "dish_sales_dishId_fkey"
  FOREIGN KEY ("dishId") REFERENCES "dishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dish_sales"
  ADD CONSTRAINT "dish_sales_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER INDEX IF EXISTS "stock_consumption_source_uk"
  RENAME TO "stock_consumptions_sourceType_sourceId_productId_key";
