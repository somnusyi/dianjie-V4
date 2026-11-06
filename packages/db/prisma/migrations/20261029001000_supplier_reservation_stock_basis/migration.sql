ALTER TABLE "supplier_stock_reservations" ADD COLUMN "stockUnitSnapshot" VARCHAR(16), ADD COLUMN "stockUnitsPerOrderUnitSnapshot" DECIMAL(18,6);
ALTER TABLE "supplier_stock_reservations" ADD CONSTRAINT "supplier_reservation_stock_basis_pair"
CHECK (("stockUnitSnapshot" IS NULL) = ("stockUnitsPerOrderUnitSnapshot" IS NULL)
  AND ("stockUnitSnapshot" IS NULL OR (length(trim("stockUnitSnapshot")) > 0 AND "stockUnitsPerOrderUnitSnapshot" > 0)));
