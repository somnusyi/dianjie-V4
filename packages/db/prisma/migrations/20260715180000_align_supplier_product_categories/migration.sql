-- Reconcile databases where the supplier category migration was applied before
-- its Prisma metadata was finalized. This is intentionally idempotent so the
-- same migration chain works for both fresh and existing installations.

ALTER TABLE "supplier_product_categories"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

DO $$
BEGIN
  IF to_regclass('"supplier_product_categories_tenantId_supplierId_isActive_sortOr"') IS NOT NULL
     AND to_regclass('"supplier_product_categories_tenantId_supplierId_isActive_so_idx"') IS NULL THEN
    ALTER INDEX "supplier_product_categories_tenantId_supplierId_isActive_sortOr"
      RENAME TO "supplier_product_categories_tenantId_supplierId_isActive_so_idx";
  END IF;
END $$;
