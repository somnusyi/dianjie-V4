-- Supplier catalog changes are not dishes. Keep NEW_DISH for historical
-- approvals and introduce explicit, additive workflow types for new records.
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'SUPPLIER_OFFER_CREATE';
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'SUPPLIER_OFFER_DISABLE';
