-- 加 MAIN_SUPPLIER (主营供应商, 长期固定合同, 有专属应付账款明细科目)
-- 餐饮门店核心货源类型, 区别于:
--   HEADQ_WAREHOUSE 总仓 (内部调拨)
--   B2B_PLATFORM 美菜/快驴 (电商账单)
--   SCATTERED 散户 (微信群)

ALTER TYPE "SupplierSourceType" ADD VALUE 'MAIN_SUPPLIER' BEFORE 'SCATTERED';
