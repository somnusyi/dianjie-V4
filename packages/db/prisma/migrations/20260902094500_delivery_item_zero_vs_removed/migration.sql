ALTER TABLE "delivery_order_items"
ADD COLUMN "removedAt" TIMESTAMP(3);

-- 旧版本只用 shippedQty=0 表示软移除；升级时将历史零数量行标记为已移除。
UPDATE "delivery_order_items"
SET "removedAt" = CURRENT_TIMESTAMP
WHERE "shippedQty" <= 0;

CREATE INDEX "delivery_order_items_deliveryOrderId_removedAt_idx"
ON "delivery_order_items"("deliveryOrderId", "removedAt");
