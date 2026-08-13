-- 门店预计库存每次读都要从最近盘点向后滚动全部收货与消耗，而 receipt_items
-- 除主键外没有任何索引(Prisma 不为外键自动建索引)，两张表都是全表扫。
-- 下周新增 4 家门店，数据量翻几倍，这条查询会成为最慢的接口。
-- 表当前都在千行量级，普通 CREATE INDEX 毫秒级完成，不需要 CONCURRENTLY。
CREATE INDEX IF NOT EXISTS "receipt_items_receiptId_idx" ON "receipt_items"("receiptId");
CREATE INDEX IF NOT EXISTS "receipt_items_productId_idx" ON "receipt_items"("productId");
CREATE INDEX IF NOT EXISTS "receipts_tenantId_storeId_deliveryDate_status_idx" ON "receipts"("tenantId", "storeId", "deliveryDate", "status");
-- 已有 (tenantId, date)，但门店维度的滚动查询会扫到全租户所有门店的消耗。
CREATE INDEX IF NOT EXISTS "stock_consumptions_tenantId_storeId_date_idx" ON "stock_consumptions"("tenantId", "storeId", "date");
