-- 上线前已经接单但尚未发货的订单也必须占用默认仓库存。
-- 历史超卖不会阻止迁移；可用量会归零，后续须补货或撤单后才能继续接单。
INSERT INTO "supplier_stock_reservations" (
    "id",
    "tenantId",
    "supplierId",
    "productId",
    "purchaseOrderId",
    "purchaseOrderItemId",
    "quantity",
    "fulfilledQty",
    "status",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy-resv-' || item."id",
    po."tenantId",
    po."supplierId",
    item."productId",
    po."id",
    item."id",
    (item."quantity" - COALESCE(item."shippedQty", 0))::DECIMAL(12,3),
    0,
    'ACTIVE'::"SupplierStockReservationStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "purchase_order_items" AS item
JOIN "purchase_orders" AS po ON po."id" = item."purchaseOrderId"
JOIN "products" AS product
  ON product."id" = item."productId"
 AND product."tenantId" = po."tenantId"
 AND product."supplierId" = po."supplierId"
WHERE po."status" = 'CONFIRMED'
  AND item."isActive" = TRUE
  AND item."quantity" - COALESCE(item."shippedQty", 0) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM "supplier_stock_reservations" AS existing
    WHERE existing."purchaseOrderItemId" = item."id"
  );
