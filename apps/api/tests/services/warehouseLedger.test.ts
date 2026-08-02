import { describe, expect, it } from 'vitest'
import { resolveFrozenOrderInventoryLine } from '../../src/services/warehouseLedger'

describe('warehouse ledger frozen order units', () => {
  it('deducts warehouse inventory in frozen inventory units instead of order units', () => {
    const line = resolveFrozenOrderInventoryLine({
      purchaseOrderItemId: 'item-1',
      productId: 'product-1',
      productName: '菌菇酱',
      quantity: 54.875,
      orderUnitSnapshot: '箱',
      inventoryUnitSnapshot: '袋',
      inventoryUnitsPerOrderUnitSnapshot: 8,
    })

    expect(line.originalQuantity.toFixed(3)).toBe('54.875')
    expect(line.conversionFactor.toFixed()).toBe('8')
    expect(line.inventoryQuantity.toFixed()).toBe('439')
    expect(line.originalUnit).toBe('箱')
    expect(line.inventoryUnit).toBe('袋')
  })

  it('allows deterministic identity fallback for legacy same-unit order lines', () => {
    const line = resolveFrozenOrderInventoryLine({
      purchaseOrderItemId: 'item-legacy',
      productId: 'product-legacy',
      productName: '旧商品',
      quantity: 3,
      productUnit: 'kg',
    })

    expect(line.conversionFactor.toFixed()).toBe('1')
    expect(line.inventoryQuantity.toFixed()).toBe('3')
    expect(line.originalUnit).toBe('kg')
    expect(line.inventoryUnit).toBe('kg')
  })

  it('refuses a known unit mismatch without a frozen conversion factor', () => {
    expect(() => resolveFrozenOrderInventoryLine({
      purchaseOrderItemId: 'item-bad',
      productId: 'product-bad',
      productName: '单位异常商品',
      quantity: 1,
      orderUnitSnapshot: '箱',
      inventoryUnitSnapshot: '袋',
      inventoryUnitsPerOrderUnitSnapshot: null,
    })).toThrow('缺少订货单位到库存单位的冻结换算')
  })
})
