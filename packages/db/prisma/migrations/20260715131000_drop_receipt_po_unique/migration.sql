-- Prisma originally created this as a standalone unique index rather than a named constraint.
-- One purchase order may now have multiple receipts, one per delivery order.
DROP INDEX IF EXISTS "receipts_purchaseOrderId_key";
