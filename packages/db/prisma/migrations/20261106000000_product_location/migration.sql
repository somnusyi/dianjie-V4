-- Optional pick location only; existing products remain unset. No stock or financial data changes.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "location" VARCHAR(32);
