ALTER TABLE "warehouse_stocktakes" ADD COLUMN "countScope" VARCHAR(16) NOT NULL DEFAULT 'SELECTED';
ALTER TABLE "warehouse_stocktake_items" ADD COLUMN "unitPending" BOOLEAN NOT NULL DEFAULT false;
