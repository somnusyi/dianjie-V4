-- 门店提交内部总仓订单时的零库存阻断开关。
-- 该字段不参与台账投影、接单预占或发货出库。
-- 历史页面无论库存模式都是“断货提醒后仍可下单”，因此全部兼容回填 false。
-- 在 ADD COLUMN 时直接带默认值与非空约束，避免旧应用并发新建仓库插入 NULL。
ALTER TABLE "warehouses"
ADD COLUMN "blockZeroStockAtOrderEntry" BOOLEAN NOT NULL DEFAULT false;
