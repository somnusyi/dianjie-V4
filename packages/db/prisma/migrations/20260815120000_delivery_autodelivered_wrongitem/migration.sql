-- 送达兜底标记：发货超 24h 未人工点送达时系统自动推进；此类配送单跳过 24h 自动收货。
ALTER TABLE "delivery_orders" ADD COLUMN "autoDelivered" BOOLEAN NOT NULL DEFAULT false;

-- 差异单新增"错发"类型：实际送达 SKU 与订单行不符（品项级更正与退回的入口）。
ALTER TYPE "LossClaimKind" ADD VALUE 'WRONG_ITEM';
