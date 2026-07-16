-- Package conversions such as 1g into a 16kg case need more than four decimals.
ALTER TABLE "dish_recipes" ALTER COLUMN "quantity" TYPE DECIMAL(14,6);
ALTER TABLE "stock_consumptions" ALTER COLUMN "quantity" TYPE DECIMAL(14,6);
