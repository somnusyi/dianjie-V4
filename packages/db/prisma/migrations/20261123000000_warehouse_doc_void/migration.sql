-- A hand-entered warehouse receipt is never physically deleted.  The
-- document remains auditable while immutable reversal movements remove its
-- inventory effect.
ALTER TYPE "WarehouseDocStatus" ADD VALUE IF NOT EXISTS 'VOIDED';
ALTER TYPE "WarehouseDocLogAction" ADD VALUE IF NOT EXISTS 'VOID';
