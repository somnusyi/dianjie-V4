-- Keep the physical-count source quantity untouched and store a separately audited
-- quantity in the purchasing SKU unit. This prevents bags/jin/bottles being added
-- directly to receipts recorded in boxes/pieces.
ALTER TABLE "inventory_snapshot_items"
    ADD COLUMN IF NOT EXISTS "normalizedQuantity" DECIMAL(14,6),
    ADD COLUMN IF NOT EXISTS "normalizedUnit" TEXT,
    ADD COLUMN IF NOT EXISTS "normalizationFactor" DECIMAL(18,8),
    ADD COLUMN IF NOT EXISTS "normalizationStatus" VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "normalizationNote" TEXT;
