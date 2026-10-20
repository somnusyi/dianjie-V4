import { describe, expect, it } from 'vitest'
import { currentMonthRange, loadCreatedRecord, receiptReviewActionForStatus, shortDate, unitPriceMoney, money, statusTone } from './upstream-procurement'

describe('upstream procurement UI helpers', () => {
  it('builds the complete local calendar month', () => {
    expect(currentMonthRange(new Date(2026, 1, 10))).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('formats missing dates safely', () => {
    expect(shortDate(null)).toBe('—')
    expect(shortDate('not-a-date')).toBe('—')
  })

  it('uses the Shanghai business date across both UTC and local-machine day boundaries',()=>{
    expect(shortDate('2026-10-10T00:00:00.000Z')).toBe('2026/10/10')
    expect(shortDate('2026-10-09T16:00:00.000Z')).toBe('2026/10/10')
    expect(shortDate('2026-10-09T15:59:59.000Z')).toBe('2026/10/9')
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


it('keeps accepted unit-price precision distinct from two-decimal amount formatting', () => {
  expect(unitPriceMoney('42.125')).toBe('¥42.125')
  expect(unitPriceMoney('0.005')).toBe('¥0.005')
  expect(unitPriceMoney('0.000001')).toBe('¥0.000001')
  expect(unitPriceMoney('33.333333')).toBe('¥33.333333')
  expect(unitPriceMoney('40')).toBe('¥40.00')
  expect(unitPriceMoney('41.25')).toBe('¥41.25')
  expect(unitPriceMoney('invalid')).toBe('—')
  expect(money('126.375')).toBe('¥126.38')
})
