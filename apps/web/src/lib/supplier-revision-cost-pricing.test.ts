import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  calculateRevisionLineAmount,
  resolveRevisionCatalogPricing,
  sumRevisionLineAmounts,
} from './supplier-revision-cost-pricing'

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  name: '测试商品',
  status: 'ENABLED',
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

describe('resolveRevisionCatalogPricing', () => {
  it('keeps 1:1 legacy product ready even without structured fields', () => {
    const result = resolveRevisionCatalogPricing(product({
      price: '8.50',
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

  it('converts a non-1:1 inferred contract to order unit price', () => {
    const result = resolveRevisionCatalogPricing(product({
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

  it('converts cost per g into order price per 斤', () => {
    const result = resolveRevisionCatalogPricing(product({
      price: '0.02',
      unit: '斤',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '斤',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '10000',
      inventoryUnitsPerOrderUnit: '500',
      inventoryUnitsPerCostUnit: '1',
    }))
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.orderUnitPrice).toBe('10.00')
      expect(result.unitLabel).toBe('元 / 斤')
    }
  })

  it('does not guess an explicit non-1:1 PENDING contract', () => {
    const result = resolveRevisionCatalogPricing(product({
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
    ['invalid status on a non-1:1 contract', { purchaseUnit: '箱', unitConversionStatus: 'DRAFT' }],
  ])('returns PENDING for %s', (_case, overrides) => {
    const result = resolveRevisionCatalogPricing(product(overrides))
    expect(result.status).toBe('PENDING')
    expect((result as { message: string }).message).toContain('测试商品')
  })

  it('returns PENDING when the cost price is invalid', () => {
    const result = resolveRevisionCatalogPricing(product({ price: '-1' }))
    expect(result).toMatchObject({
      status: 'PENDING',
      message: '测试商品 的采购成本单价无效，暂不能计算订货价格',
    })
  })
})

describe('calculateRevisionLineAmount', () => {
  it('returns null when pricing is pending', () => {
    const pricing = { status: 'PENDING' as const, message: '待核验' }
    expect(calculateRevisionLineAmount(3, pricing)).toBeNull()
  })

  it('computes amount using the rounded order unit price', () => {
    const pricing = {
      status: 'READY' as const,
      orderUnitPrice: '10.00',
      orderUnit: '斤',
      unitLabel: '元 / 斤',
      costPriceSource: '成本价来源：¥0.02 / g',
    }
    expect(calculateRevisionLineAmount('2.5', pricing)).toBe('25.00')
  })
})

describe('sumRevisionLineAmounts', () => {
  it('sums ready amounts', () => {
    expect(sumRevisionLineAmounts(['25.00', '12.34'])).toBe('37.34')
  })

  it('returns null when any amount is missing', () => {
    expect(sumRevisionLineAmounts(['25.00', null])).toBeNull()
  })
})

describe('supplier revision page pricing contract', () => {
  const source = readFileSync(
    new URL('../app/v2/supplier/orders/[id]/page.tsx', import.meta.url),
    'utf8',
  )

  it('uses current four-unit pricing only for newly added catalog products', () => {
    expect(source).toContain('resolveRevisionCatalogPricing(p)')
    expect(source).toContain('pricing.orderUnitPrice')
    expect(source).not.toContain('Number(p.price)')
  })

  it('keeps existing rows on their frozen price and unit snapshots', () => {
    expect(source).toContain('existing.unitPrice')
    expect(source).toContain('existing.orderUnitSnapshot || existing.productUnitSnapshot')
    expect(source).toContain('历史冻结价')
  })

  it('does not present a zero total while a selected catalog price is pending', () => {
    expect(source).toContain("selectedTotal === null ? 'text-caption text-red-fg'")
    expect(source).toContain('调整后金额待核验')
    expect(source).toContain('hasPendingSelected')
  })
})
