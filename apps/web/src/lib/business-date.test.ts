import { expect, it } from 'vitest'
import { businessDateKey, businessMonthKey, monthDateKeys, businessMonthBounds, businessDateTimeInput, businessDateTimeToIso } from './business-date'
it.each([
  ['2025-12-31T15:59:59.999Z', '2025-12-31', '2025-12'],
  ['2025-12-31T16:00:00.000Z', '2026-01-01', '2026-01'],
  ['2026-01-31T16:00:00.000Z', '2026-02-01', '2026-02'],
])('uses the business year and month for %s', (instant, day, month) => {
  expect(businessDateKey(instant)).toBe(day)
  expect(businessMonthKey(instant)).toBe(month)
})
it('keeps leap-month and year-end calendar keys without ISO timezone truncation', () => {
  expect(monthDateKeys('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  expect(monthDateKeys('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  expect(businessMonthKey('not-a-date')).toBe('')
  expect(() => monthDateKeys('2026-13')).toThrow()
})

it('uses an exclusive Shanghai month end for filtering and export', () => {
  expect(businessMonthBounds('2026-01')).toEqual({start:'2025-12-31T16:00:00.000Z',endExclusive:'2026-01-31T16:00:00.000Z'})
  expect(businessMonthBounds('2024-02')).toEqual({start:'2024-01-31T16:00:00.000Z',endExclusive:'2024-02-29T16:00:00.000Z'})
})

it.each([
  ['2026-11-05T15:59:00.000Z', '2026-11-05T23:59'],
  ['2026-11-05T16:00:00.000Z', '2026-11-06T00:00'],
  ['2026-11-06T01:30:00.000Z', '2026-11-06T09:30'],
  ['2026-12-31T16:00:00.000Z', '2027-01-01T00:00'],
])('shows and submits the same Beijing instant across browser timezones: %s', (iso, input) => {
  expect(businessDateTimeInput(iso)).toBe(input)
  expect(businessDateTimeToIso(input)).toBe(iso)
})

it.each(['', 'not-a-date', '2026-02-30T10:00', '2026-11-05T24:00', '2026-13-01T10:00'])('does not normalize an invalid input into a different date: %s', value => {
  expect(businessDateTimeToIso(value)).toBe('')
})
