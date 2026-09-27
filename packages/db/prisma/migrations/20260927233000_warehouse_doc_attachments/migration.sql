-- Additive, nullable metadata for supplier delivery documents attached to
-- manual purchase-inbound warehouse documents. Existing rows need no backfill.
ALTER TABLE "warehouse_docs"
ADD COLUMN "attachments" JSONB;
