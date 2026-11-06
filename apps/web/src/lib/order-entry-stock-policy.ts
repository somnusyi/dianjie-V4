export type OrderEntryInventoryMode = 'STRICT' | 'NOT_TRACKED'

export type OrderEntryStockProduct = {
  stock?: string | number | null
  availableStock?: string | number | null
  inventoryTracked?: boolean | null
  inventoryEnforced?: boolean | null
}

export type OrderEntryStockSupplier = {
  inventoryMode?: OrderEntryInventoryMode | null
}

export function isOrderEntryZeroStock(
  product: OrderEntryStockProduct,
  _supplier?: OrderEntryStockSupplier | null,
) {
  const available = Number(product.availableStock ?? product.stock ?? 0)
  return Number.isFinite(available) && available <= 0
}

export function isOrderEntryStockBlocked(
  product: OrderEntryStockProduct,
  supplier?: OrderEntryStockSupplier | null,
) {
  // 只认后端按商品行返回的提交预占策略；不根据供应商标签或旧仓库开关猜测，
  // 未跟踪库存的外部供货仍可提交。
  return product.inventoryEnforced === true && isOrderEntryZeroStock(product, supplier)
}
