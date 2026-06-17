-- 门店指定收货人 (一般是厨师长) — 供应商送货单显示此人, 空则回退店长 managerName/phone
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "consigneeId" TEXT;
