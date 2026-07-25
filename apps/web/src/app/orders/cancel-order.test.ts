import { describe, expect, it } from 'vitest'
import { canCancelLegacyOrder, validateCancelReason } from './cancel-order'

describe('legacy order cancellation contract', () => {
  it('allows managers and admins only before shipment', () => {
    expect(canCancelLegacyOrder('SUBMITTED', 'MANAGER')).toBe(true)
    expect(canCancelLegacyOrder('CONFIRMED', 'ADMIN')).toBe(true)
    expect(canCancelLegacyOrder('DELIVERING', 'MANAGER')).toBe(false)
    expect(canCancelLegacyOrder('SUBMITTED', 'SUPPLIER_OWNER')).toBe(false)
  })

  it('requires a trimmed reason and enforces the API length limit', () => {
    expect(validateCancelReason('  门店临时停业  ')).toEqual({ success: true, reason: '门店临时停业' })
    expect(validateCancelReason('   ')).toEqual({ success: false, error: '请填写撤回原因' })
    expect(validateCancelReason('a'.repeat(201))).toEqual({ success: false, error: '撤回原因最长 200 字' })
  })
})
