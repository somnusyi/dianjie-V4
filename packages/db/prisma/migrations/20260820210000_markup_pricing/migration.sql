-- 比例加价定价：商品定价方式 + 分类默认加价比例
ALTER TABLE "products" ADD COLUMN "pricingMode" VARCHAR(16);
ALTER TABLE "products" ADD COLUMN "markupPercent" DECIMAL(7,2);
ALTER TABLE "supplier_product_categories" ADD COLUMN "defaultMarkupPercent" DECIMAL(7,2);
