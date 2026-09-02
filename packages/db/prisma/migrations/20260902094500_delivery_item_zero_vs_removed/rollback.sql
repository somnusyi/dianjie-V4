DROP INDEX IF EXISTS "delivery_order_items_deliveryOrderId_removedAt_idx";

ALTER TABLE "delivery_order_items"
DROP COLUMN IF EXISTS "removedAt";
