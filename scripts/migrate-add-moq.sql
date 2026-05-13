-- 给 products 表加 起订量 / 步长 字段 (默认 1, 不破坏存量)
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "minOrderQty" DECIMAL(10,2) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "stepQty"     DECIMAL(10,2) NOT NULL DEFAULT 1;
