-- StockConsumption 加 source 字段, 实现 DishSale → 自动扣库存的幂等
ALTER TABLE "stock_consumptions"
  ALTER COLUMN "quantity" TYPE DECIMAL(10,4),
  ADD COLUMN "sourceType" VARCHAR(20),
  ADD COLUMN "sourceId" VARCHAR(64);

-- 同 sourceType+sourceId+productId 唯一 (避免同 DishSale 重复扣)
-- NULL 不参与 unique (PG 默认), 所以历史手工录入数据不受影响
CREATE UNIQUE INDEX "stock_consumption_source_uk"
  ON "stock_consumptions"("sourceType", "sourceId", "productId");

CREATE INDEX IF NOT EXISTS "stock_consumptions_tenantId_date_idx"
  ON "stock_consumptions"("tenantId", "date");
