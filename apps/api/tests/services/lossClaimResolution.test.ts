import { describe, expect, it } from 'vitest'
import { lossClaimResolutionSchema, proratedLossQuantity } from '../../src/services/lossClaimResolution'

describe('loss claim resolution', () => {
  it('validates a non-negative two-decimal resolution amount', () => {
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: 12.34 }).success).toBe(true)
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: -1 }).success).toBe(false)
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: 1.234 }).success).toBe(false)
  })

  it('prorates inventory refund quantity by the accepted amount', () => {
    expect(proratedLossQuantity(10, 25, 100).toString()).toBe('2.5')
    expect(proratedLossQuantity(10, 100, 100).toString()).toBe('10')
    expect(proratedLossQuantity(10, 0, 100).toString()).toBe('0')
  })

  it('clamps the ratio to the claim total defensively', () => {
    expect(proratedLossQuantity(10, 120, 100).toString()).toBe('10')
  })
})
