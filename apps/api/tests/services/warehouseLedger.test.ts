import { describe, expect, it } from 'vitest'
import {
  resolveFrozenOrderInventoryLine,
  sumDeliveryOutboundCostRows,
  summarizeDeliveryOutboundCostRows,
} from '../../src/services/warehouseLedger'

describe('delivery outbound cost export', () => {
  it('adds all frozen outbound movement costs per delivery and keeps cents', () => {
    const totals = sumDeliveryOutboundCostRows([
      { id: 'movement-1', sourceId: 'delivery-1', valueDelta: '-12.3456' },
      { id: 'movement-2', sourceId: 'delivery-1', valueDelta: '-7.6544' },
      { id: 'movement-3', sourceId: 'delivery-2', valueDelta: '-3.5' },
    ])

    expect(totals.get('delivery-1')).toBe('20.00')
    expect(totals.get('delivery-2')).toBe('3.50')
  })

  it('subtracts frozen reversal value and ignores an invalid positive outbound value', () => {
    const totals = sumDeliveryOutboundCostRows([
      { id: 'movement-1', sourceId: 'delivery-1', valueDelta: '-20' },
      { id: 'movement-invalid', sourceId: 'delivery-1', valueDelta: '99' },
    ], [
      { sourceLineId: 'movement-1', valueDelta: '6.25' },
    ])

    expect(totals.get('delivery-1')).toBe('13.75')
  })

  it('returns each delivery-item cost by purchase order item and applies reversals', () => {
    const breakdowns = summarizeDeliveryOutboundCostRows([
      { id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', valueDelta: '-12.50' },
      { id: 'movement-2', sourceId: 'delivery-1', sourceLineId: 'order-item-1', valueDelta: '-2.50' },
      { id: 'movement-3', sourceId: 'delivery-1', sourceLineId: 'order-item-2', valueDelta: '-8.00' },
    ], [
      { sourceLineId: 'movement-1', valueDelta: '3.25' },
    ])

    expect(breakdowns.get('delivery-1')?.total).toBe('19.75')
    expect(breakdowns.get('delivery-1')?.lineAmounts.get('order-item-1')).toBe('11.75')
    expect(breakdowns.get('delivery-1')?.lineAmounts.get('order-item-2')).toBe('8.00')
  })
})

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
