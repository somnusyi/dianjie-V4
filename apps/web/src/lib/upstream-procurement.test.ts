import { describe, expect, it } from 'vitest'
import { currentMonthRange, loadCreatedRecord, receiptReviewActionForStatus, shortDate, statusTone } from './upstream-procurement'

describe('upstream procurement UI helpers', () => {
  it('builds the complete local calendar month', () => {
    expect(currentMonthRange(new Date(2026, 1, 10))).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('formats missing dates safely', () => {
    expect(shortDate(null)).toBe('—')
    expect(shortDate('not-a-date')).toBe('—')
  })

  it('makes review states visually distinct', () => {
    expect(statusTone('PENDING_REVIEW')).toContain('amber')
    expect(statusTone('POSTED')).toContain('green')
  })

  it.each([
    ['DRAFT', null],
    ['INSPECTING', 'confirm'],
    ['PENDING_REVIEW', 'review'],
    ['POSTED', null],
    ['REVERSED', null],
  ])('maps receipt status %s to next action %s', (status, expected) => {
    expect(receiptReviewActionForStatus(status)).toBe(expected)
  })

  it('keeps a successful mutation successful when its detail refresh fails', async () => {
    await expect(loadCreatedRecord('new-id', async () => { throw new Error('network') })).resolves.toBeNull()
    await expect(loadCreatedRecord('new-id', async () => [{ id: 'new-id', name: '新合同' }])).resolves.toEqual({
      rows: [{ id: 'new-id', name: '新合同' }],
      record: { id: 'new-id', name: '新合同' },
    })
  })
})
