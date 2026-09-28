ALTER TABLE "delivery_orders"
  ADD COLUMN "pickerNameSnapshot" VARCHAR(80),
  ADD COLUMN "driverNameSnapshot" VARCHAR(80);

ALTER TABLE "delivery_orders"
  ADD CONSTRAINT "delivery_orders_picker_name_nonblank_check"
  CHECK ("pickerNameSnapshot" IS NULL OR length(btrim("pickerNameSnapshot")) > 0),
  ADD CONSTRAINT "delivery_orders_driver_name_nonblank_check"
  CHECK ("driverNameSnapshot" IS NULL OR length(btrim("driverNameSnapshot")) > 0);

COMMENT ON COLUMN "delivery_orders"."pickerNameSnapshot" IS
  '实际分拣负责人姓名快照；与 shippedById（发货状态操作人）分开记录';
COMMENT ON COLUMN "delivery_orders"."driverNameSnapshot" IS
  '实际配送/司机姓名快照；与 deliveredById（送达状态操作人）分开记录';
