import { describe, expect, it } from 'vitest'
import { lossClaimResolutionSchema } from '../../src/services/lossClaimResolution'
import { scheduleStatusAfterDispute } from '../../src/services/receiptSettlement'

describe('loss claim resolution', () => {
  it('validates a non-negative two-decimal resolution amount', () => {
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: 12.34 }).success).toBe(true)
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: -1 }).success).toBe(false)
    expect(lossClaimResolutionSchema.safeParse({ finalDeductAmount: 1.234 }).success).toBe(false)
  })

  it('restores the required approval gate after a dispute', () => {
    expect(scheduleStatusAfterDispute({ needApproval: false })).toBe('PENDING')
    expect(scheduleStatusAfterDispute({ needApproval: true })).toBe('PENDING_APPROVAL')
  })
})
