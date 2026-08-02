import { Prisma } from '@dianjie/db'
import { describe, expect, it } from 'vitest'
import { validateOrderDraftLines, type OrderDraftProduct } from '../../src/services/orderDraftValidation'

function product(overrides: Partial<OrderDraftProduct> = {}): OrderDraftProduct {
  return {
    id: 'product-1',
    name: '乌苏罐装',
    unit: '罐',
    minOrderQty: new Prisma.Decimal(2),
    stepQty: new Prisma.Decimal(2),
    price: new Prisma.Decimal(5),
    purchaseUnit: '箱',
    inventoryUnit: '罐',
    orderUnit: '罐',
    costUnit: '罐',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(6),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    unitConversionStatus: 'VERIFIED',
    ...overrides,
  }
}

describe('shared order draft validation', () => {
  it('builds authoritative priced lines for a valid draft', () => {
    const result = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 4 }])

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.totalAmount?.toFixed(2)).toBe('20.00')
    expect(result.lines[0]).toMatchObject({
      productId: 'product-1',
      quantity: 4,
      orderUnitSnapshot: '罐',
    })
  })

  it('applies the same duplicate, availability, minimum and step blockers used by real creation', () => {
    const duplicate = validateOrderDraftLines([product()], [
      { productId: 'product-1', quantity: 2 },
      { productId: 'product-1', quantity: 2 },
    ])
    const missing = validateOrderDraftLines([], [{ productId: 'missing', quantity: 1 }])
    const minimum = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 1 }])
    const step = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 3 }])

    expect(duplicate.issues.some(issue => issue.code === 'DUPLICATE_PRODUCT')).toBe(true)
    expect(missing.issues[0].code).toBe('PRODUCT_UNAVAILABLE')
    expect(minimum.issues[0].code).toBe('BELOW_MINIMUM')
    expect(step.issues[0].code).toBe('INVALID_STEP')
  })

  it('blocks a pending four-unit contract instead of inventing a price', () => {
    const result = validateOrderDraftLines(
      [product({ unitConversionStatus: 'PENDING' })],
      [{ productId: 'product-1', quantity: 2 }],
    )

    expect(result.ok).toBe(false)
    expect(result.issues[0].code).toBe('PRICE_UNAVAILABLE')
    expect(result.lines).toEqual([])
  })
})
