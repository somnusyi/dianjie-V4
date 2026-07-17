-- Establish an auditable opening balance for legacy supplier SKUs that have a
-- physical balance but no stock ledger at all. This migration never changes
-- products.stock. It only records the already-existing balance.
INSERT INTO "supplier_stock_movements" (
  "id",
  "tenantId",
  "supplierId",
  "productId",
  "delta",
  "balanceAfter",
  "type",
  "reason",
  "sourceType",
  "sourceId",
  "createdById",
  "createdAt"
)
SELECT
  'legacy-opening-' || p."id",
  p."tenantId",
  p."supplierId",
  p."id",
  p."stock"::numeric(12,3),
  p."stock"::numeric(12,3),
  'INITIAL'::"StockMovementType",
  '系统迁移：以迁移前商品库存建立期初余额，不改变实物库存',
  'LegacyOpeningBalance',
  p."id",
  actor."id",
  p."createdAt"
FROM "products" p
JOIN LATERAL (
  SELECT u."id"
  FROM "users" u
  WHERE u."tenantId" = p."tenantId"
    AND (
      u."supplierId" = p."supplierId"
      OR u."role" IN ('ADMIN', 'SUPER_ADMIN')
    )
  ORDER BY
    CASE WHEN u."supplierId" = p."supplierId" THEN 0 ELSE 1 END,
    u."createdAt" ASC,
    u."id" ASC
  LIMIT 1
) actor ON TRUE
WHERE p."supplierId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "supplier_stock_movements" movement
    WHERE movement."productId" = p."id"
  )
ON CONFLICT ("id") DO NOTHING;
