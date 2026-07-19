import { describe, expect, it } from 'vitest'
import { applyReceiptToCostSlot } from '../../src/services/inventoryCosting'

describe('moving-average inventory costing', () => {
  it('weights a new receipt by the remaining positive stock', () => {
    const result = applyReceiptToCostSlot({ quantity: 10, averageCost: 2 }, 5, 5)
    expect(result.quantity).toBe(15)
    expect(result.averageCost).toBeCloseTo(3)
  })

  it('uses the new receipt price after estimated stock went negative', () => {
    const result = applyReceiptToCostSlot({ quantity: -3, averageCost: 2 }, 10, 5)
    expect(result.quantity).toBe(7)
    expect(result.averageCost).toBe(5)
  })

  it('ignores non-positive receipt quantities', () => {
    expect(applyReceiptToCostSlot({ quantity: 10, averageCost: 2 }, 0, 99))
      .toEqual({ quantity: 10, averageCost: 2 })
  })
})
