ALTER TABLE "delivery_order_items"
ADD COLUMN "productCodeSnapshot" TEXT,
ADD COLUMN "productNameSnapshot" TEXT,
ADD COLUMN "productSpecSnapshot" TEXT,
ADD COLUMN "productUnitSnapshot" TEXT,
ADD COLUMN "productCategorySnapshot" TEXT;

ALTER TABLE "receipt_items"
ADD COLUMN "productCodeSnapshot" TEXT,
ADD COLUMN "productNameSnapshot" TEXT,
ADD COLUMN "productSpecSnapshot" TEXT,
ADD COLUMN "productUnitSnapshot" TEXT,
ADD COLUMN "productCategorySnapshot" TEXT;

ALTER TABLE "loss_claim_items"
ADD COLUMN "productCodeSnapshot" TEXT,
ADD COLUMN "productNameSnapshot" TEXT,
ADD COLUMN "productSpecSnapshot" TEXT,
ADD COLUMN "productUnitSnapshot" TEXT,
ADD COLUMN "productCategorySnapshot" TEXT;

-- 历史数据先按当前商品主数据回填一次；此后新单据在创建时冻结快照。
UPDATE "delivery_order_items" AS item
SET "productCodeSnapshot" = product."code",
    "productNameSnapshot" = product."name",
    "productSpecSnapshot" = product."spec",
    "productUnitSnapshot" = product."unit",
    "productCategorySnapshot" = product."category"
FROM "products" AS product
WHERE product."id" = item."productId";

UPDATE "receipt_items" AS item
SET "productCodeSnapshot" = product."code",
    "productNameSnapshot" = product."name",
    "productSpecSnapshot" = product."spec",
    "productUnitSnapshot" = product."unit",
    "productCategorySnapshot" = product."category"
FROM "products" AS product
WHERE product."id" = item."productId";

UPDATE "loss_claim_items" AS item
SET "productCodeSnapshot" = product."code",
    "productNameSnapshot" = product."name",
    "productSpecSnapshot" = product."spec",
    "productUnitSnapshot" = product."unit",
    "productCategorySnapshot" = product."category"
FROM "products" AS product
WHERE product."id" = item."productId";
