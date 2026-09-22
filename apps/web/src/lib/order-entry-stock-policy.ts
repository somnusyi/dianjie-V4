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
  // 只认后端按商品行返回的显式策略。供应商 STRICT 属于接单预占规则，
  // 不能被前端推断为“门店提交阶段禁止下单”。
  return product.inventoryEnforced === true && isOrderEntryZeroStock(product, supplier)
}
