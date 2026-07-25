import { Prisma } from '@dianjie/db'
import { describe, expect, it } from 'vitest'
import {
  costUnitPriceToOrderUnitPrice,
  costUnitPricedOrderLine,
  tryCostUnitPriceToOrderUnitPrice,
} from '../../src/services/costUnitPricing'

const product = (overrides: Record<string, unknown> = {}) => ({
  unit: '件',
  purchaseUnit: '件',
  inventoryUnit: '件',
  orderUnit: '件',
  costUnit: '件',
  inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(1),
  inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
  inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
  unitConversionStatus: 'PENDING',
  price: new Prisma.Decimal('12.34'),
  name: '测试商品',
  ...overrides,
})

describe('cost-unit purchase order pricing', () => {
  it('preserves legacy and compatibility same-unit 1:1 pricing', () => {
    const compatibility = costUnitPricedOrderLine({ product: product(), quantity: '3' })
    const legacy = costUnitPricedOrderLine({
      product: product({
        purchaseUnit: null,
        inventoryUnit: null,
        orderUnit: null,
        costUnit: null,
        inventoryUnitsPerPurchaseUnit: null,
        inventoryUnitsPerOrderUnit: null,
        inventoryUnitsPerCostUnit: null,
      }),
      quantity: '3',
    })

    expect(compatibility.unitPrice.toFixed(2)).toBe('12.34')
    expect(compatibility.amount.toFixed(2)).toBe('37.02')
    expect(legacy.unitPrice.toFixed(2)).toBe('12.34')
    expect(legacy.amount.toFixed(2)).toBe('37.02')
  })

  it('converts a cost price per g into a price per 500g 斤', () => {
    const result = costUnitPricedOrderLine({
      product: product({
        unit: '斤',
        purchaseUnit: '箱',
        inventoryUnit: 'g',
        orderUnit: '斤',
        costUnit: 'g',
        inventoryUnitsPerPurchaseUnit: '10000.000000',
        inventoryUnitsPerOrderUnit: '500.000000',
        inventoryUnitsPerCostUnit: '1.000000',
        unitConversionStatus: 'VERIFIED',
        price: '0.02',
      }),
      quantity: '2',
    })

    expect(result.unitPrice.toFixed(2)).toBe('10.00')
    expect(result.amount.toFixed(2)).toBe('20.00')
  })

  it('converts between different cost and order units', () => {
    const result = costUnitPricedOrderLine({
      product: product({
        unit: '箱',
        purchaseUnit: '箱',
        inventoryUnit: '瓶',
        orderUnit: '箱',
        costUnit: '打',
        inventoryUnitsPerPurchaseUnit: '12',
        inventoryUnitsPerOrderUnit: '12',
        inventoryUnitsPerCostUnit: '6',
        unitConversionStatus: 'INFERRED',
        price: '20',
      }),
      quantity: '3',
    })

    expect(result.unitPrice.toFixed(2)).toBe('40.00')
    expect(result.amount.toFixed(2)).toBe('120.00')
  })

  it('keeps six-decimal factors in Decimal arithmetic until money boundaries', () => {
    const result = costUnitPricedOrderLine({
      product: product({
        unit: '袋',
        purchaseUnit: '袋',
        inventoryUnit: 'kg',
        orderUnit: '袋',
        costUnit: '勺',
        inventoryUnitsPerPurchaseUnit: '0.333333',
        inventoryUnitsPerOrderUnit: '0.333333',
        inventoryUnitsPerCostUnit: '0.111111',
        unitConversionStatus: 'VERIFIED',
        price: '0.01',
      }),
      quantity: '10',
    })

    expect(result.unitPrice.toFixed(2)).toBe('0.03')
    expect(result.amount.toFixed(2)).toBe('0.30')
  })

  it('rejects pending, incomplete, zero and negative explicit contracts', () => {
    const explicit = {
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '箱',
      costUnit: '瓶',
      inventoryUnitsPerPurchaseUnit: '12',
      inventoryUnitsPerOrderUnit: '12',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'VERIFIED',
    }
    const invalidProducts = [
      product({ ...explicit, unitConversionStatus: 'PENDING' }),
      product({ ...explicit, costUnit: null }),
      product({ purchaseUnit: null }),
      product({ ...explicit, inventoryUnitsPerOrderUnit: '0' }),
      product({ ...explicit, inventoryUnitsPerCostUnit: '-1' }),
    ]

    for (const invalidProduct of invalidProducts) {
      expect(() => costUnitPricedOrderLine({
        product: invalidProduct,
        quantity: '1',
      })).toThrow('四单位换算待核验或不完整')
    }
  })

  it('accepts exact database money maxima and rejects unit-price or amount overflow', () => {
    const exactMaximum = costUnitPricedOrderLine({
      product: product({
        price: '99999999.99',
        unitConversionStatus: 'VERIFIED',
      }),
      quantity: '100',
    })
    expect(exactMaximum.unitPrice.toFixed(2)).toBe('99999999.99')
    expect(exactMaximum.amount.toFixed(2)).toBe('9999999999.00')

    expect(() => costUnitPricedOrderLine({
      product: product({
        unit: '箱',
        purchaseUnit: '箱',
        inventoryUnit: '件',
        orderUnit: '箱',
        costUnit: '件',
        inventoryUnitsPerPurchaseUnit: '2',
        inventoryUnitsPerOrderUnit: '2',
        inventoryUnitsPerCostUnit: '1',
        unitConversionStatus: 'VERIFIED',
        price: '99999999.99',
      }),
      quantity: '1',
    })).toThrow('每订货单位单价超过系统上限')

    expect(() => costUnitPricedOrderLine({
      product: product({
        price: '99999999.99',
        unitConversionStatus: 'VERIFIED',
      }),
      quantity: '101',
    })).toThrow('单行金额超过系统上限')
  })
})

describe('cost-unit inventory valuation', () => {
  it('converts the cost-unit price before valuing order-unit stock', () => {
    const converted = costUnitPriceToOrderUnitPrice(product({
      unit: '斤',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '斤',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '10000',
      inventoryUnitsPerOrderUnit: '500',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'VERIFIED',
      price: '0.02',
    }))

    expect(converted.toFixed(2)).toBe('10.00')
  })

  it('returns null instead of silently misvaluing an explicit pending contract', () => {
    expect(tryCostUnitPriceToOrderUnitPrice(product({
      unit: '斤',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '斤',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '10000',
      inventoryUnitsPerOrderUnit: '500',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'PENDING',
      price: '0.02',
    }))).toBeNull()
  })
})
