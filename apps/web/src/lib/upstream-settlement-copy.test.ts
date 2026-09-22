import { describe, expect, it } from 'vitest'
import { claimResolutionCopy, settlementLineTypeLabel } from './upstream-settlement-copy'

describe('上游差异和对账提示语', () => {
  it('只把真正调整应付的差异行称为扣款', () => {
    expect(settlementLineTypeLabel('RECEIPT', 100)).toBe('收货')
    expect(settlementLineTypeLabel('CLAIM', 0)).toBe('差异记录')
    expect(settlementLineTypeLabel('CLAIM', -50)).toBe('差异扣款')
  })

  it('初始少发办结时明确不重复扣款', () => {
    const copy = claimResolutionCopy('SHORTAGE', '¥50.00')
    expect(copy.button).toBe('确认责任并办结')
    expect(copy.confirmation).toContain('不会重复扣款')
  })

  it('收货后破损仍按扣款办结', () => {
    const copy = claimResolutionCopy('POST_RECEIPT_DAMAGE', '¥50.00')
    expect(copy.button).toBe('确认责任并扣款')
    expect(copy.confirmation).toContain('¥50.00')
  })
})
