import { describe, expect, it } from 'vitest'
import { currentMonthRange, shortDate, statusTone } from './upstream-procurement'

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
})
