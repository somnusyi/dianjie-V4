-- AlterTable: Product 加 shipUpperPct + shipUpperBuffer 让供应商可配
-- 默认 1.10 / 5.00 跟之前全局阈值一致, 老数据 0 行为变化
ALTER TABLE "products"
  ADD COLUMN "shipUpperBuffer" DECIMAL(10,2) NOT NULL DEFAULT 5.00,
  ADD COLUMN "shipUpperPct"    DECIMAL(5,2)  NOT NULL DEFAULT 1.10;
