import { describe, expect, it } from 'vitest'
import {
  calculateOrderEntryLineAmount,
  resolveOrderEntryCostPricing,
  sumOrderEntryLineAmounts,
} from './order-entry-cost-pricing'

const product = (overrides: Record<string, unknown> = {}) => ({
  name: '测试商品',
  price: '12.34',
  unit: '件',
  purchaseUnit: '件',
  inventoryUnit: '件',
  orderUnit: '件',
  costUnit: '件',
  inventoryUnitsPerPurchaseUnit: '1',
  inventoryUnitsPerOrderUnit: '1',
  inventoryUnitsPerCostUnit: '1',
  unitConversionStatus: 'VERIFIED',
  ...overrides,
})

describe('resolveOrderEntryCostPricing', () => {
  it('converts a cost price per g into an order price per 斤', () => {
    expect(resolveOrderEntryCostPricing(product({
      price: '0.02',
      unit: '斤',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '斤',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '10000',
      inventoryUnitsPerOrderUnit: '500',
      inventoryUnitsPerCostUnit: '1',
    }))).toEqual({
      status: 'READY',
      orderUnitPrice: '10.00',
      orderUnit: '斤',
      unitLabel: '元 / 斤',
      costPriceSource: '成本价来源：¥0.02 / g',
    })
  })

  it('converts between different packaging units', () => {
    const result = resolveOrderEntryCostPricing(product({
      price: '20',
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '箱',
      costUnit: '打',
      inventoryUnitsPerPurchaseUnit: '12',
      inventoryUnitsPerOrderUnit: '12',
      inventoryUnitsPerCostUnit: '6',
      unitConversionStatus: 'INFERRED',
    }))
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.orderUnitPrice).toBe('40.00')
      expect(result.unitLabel).toBe('元 / 箱')
      expect(result.costPriceSource).toBe('成本价来源：¥20.00 / 打')
    }
  })

  it('keeps six-decimal factors exact until the money boundary', () => {
    const result = resolveOrderEntryCostPricing(product({
      price: '0.01',
      unit: '袋',
      purchaseUnit: '袋',
      inventoryUnit: 'kg',
      orderUnit: '袋',
      costUnit: '勺',
      inventoryUnitsPerPurchaseUnit: '0.333333',
      inventoryUnitsPerOrderUnit: '0.333333',
      inventoryUnitsPerCostUnit: '0.111111',
    }))
    expect(result.status === 'READY' && result.orderUnitPrice).toBe('0.03')
  })

  it('allows a structureless legacy 1:1 product', () => {
    const result = resolveOrderEntryCostPricing(product({
      price: '8.5',
      unit: '包',
      purchaseUnit: null,
      inventoryUnit: null,
      orderUnit: null,
      costUnit: null,
      inventoryUnitsPerPurchaseUnit: null,
      inventoryUnitsPerOrderUnit: null,
      inventoryUnitsPerCostUnit: null,
      unitConversionStatus: 'PENDING',
    }))
    expect(result).toMatchObject({
      status: 'READY',
      orderUnitPrice: '8.50',
      orderUnit: '包',
      unitLabel: '元 / 包',
      costPriceSource: '成本价来源：¥8.50 / 包',
    })
  })

  it('allows the same-name all-one compatibility contract even while PENDING', () => {
    const result = resolveOrderEntryCostPricing(product({
      unit: '件',
      unitConversionStatus: 'PENDING',
    }))
    expect(result.status === 'READY' && result.orderUnitPrice).toBe('12.34')
  })

  it('does not guess an explicit non-1:1 PENDING contract', () => {
    const result = resolveOrderEntryCostPricing(product({
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '箱',
      costUnit: '瓶',
      inventoryUnitsPerPurchaseUnit: '12',
      inventoryUnitsPerOrderUnit: '12',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'PENDING',
    }))
    expect(result).toEqual({
      status: 'PENDING',
      message: '测试商品 的四单位换算待核验或不完整，暂不能计算订货价格',
    })
  })

  it.each([
    ['missing unit', { costUnit: null }],
    ['missing factor', { inventoryUnitsPerOrderUnit: null }],
    ['zero factor', { inventoryUnitsPerOrderUnit: 0 }],
    ['negative factor', { inventoryUnitsPerCostUnit: -1 }],
    ['infinite factor', { inventoryUnitsPerCostUnit: Infinity }],
    ['not-a-number factor', { inventoryUnitsPerCostUnit: NaN }],
  ])('returns PENDING for %s', (_case, overrides) => {
    expect(resolveOrderEntryCostPricing(product(overrides))).toMatchObject({ status: 'PENDING' })
  })
})

describe('order entry amount rounding', () => {
  it('rounds line amounts half up after using the rounded unit price', () => {
    expect(calculateOrderEntryLineAmount('1.005', '1.00')).toBe('1.01')
    expect(calculateOrderEntryLineAmount('3', '0.335')).toBe('1.01')
  })

  it('sums rounded line amounts and refuses an incomplete total', () => {
    expect(sumOrderEntryLineAmounts(['1.01', '2.02'])).toBe('3.03')
    expect(sumOrderEntryLineAmounts(['1.01', null])).toBeNull()
  })
})
