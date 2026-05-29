-- PurchaseOrder: 厨师验收单 (DELIVERING 期间厨师传照片+备注给供应商)
ALTER TABLE "purchase_orders"
  ADD COLUMN "chefAckImages" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "chefAckAt"     TIMESTAMP(3),
  ADD COLUMN "chefAckNote"   TEXT;
