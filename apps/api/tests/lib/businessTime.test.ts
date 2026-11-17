import { describe, expect, it } from 'vitest'
import {
  BUSINESS_TZ,
  businessCompactTimestampKey,
  businessDateRangeInclusive,
  businessDateOnlyRange,
  businessDateKey,
  businessMonthKey,
  businessPeriodToDateRange,
  businessTimestampKey,
} from '../../src/lib/businessTime'

// 断言与宿主机时区无关：无论 vitest 运行在哪个 TZ，业务键都按 Asia/Shanghai 切分。
describe('businessTime', () => {
  it('exposes the business timezone explicitly', () => {
    expect(BUSINESS_TZ).toBe('Asia/Shanghai')
  })

  describe('businessMonthKey', () => {
    it.each([
      ['2026-07-31T15:59:59Z', '202607'], // 上海 7/31 23:59:59
      ['2026-07-31T16:00:00Z', '202608'], // 上海 8/1 00:00:00
      ['2026-08-31T15:59:59Z', '202608'], // 上海 8/31 23:59:59
      ['2026-08-31T16:00:00Z', '202609'], // 上海 9/1 00:00:00
      ['2026-12-31T15:59:59Z', '202612'], // 年末边界
      ['2026-12-31T16:00:00Z', '202701'], // 跨年边界
    ])('maps %s to %s', (at, expected) => {
      expect(businessMonthKey(new Date(at))).toBe(expected)
    })
  })

  describe('businessDateKey', () => {
    it.each([
      ['2026-08-14T16:00:00Z', '2026-08-15'], // 上海 8/15 00:00
      ['2026-08-14T15:59:59Z', '2026-08-14'],
    ])('maps %s to %s', (at, expected) => {
      expect(businessDateKey(new Date(at))).toBe(expected)
    })
  })

  describe('businessTimestampKey', () => {
    it('renders Shanghai wall-clock with underscore separator', () => {
      expect(businessTimestampKey(new Date('2026-08-14T16:30:05Z'))).toBe('20260815_003005')
    })
  })

  describe('businessDateRangeInclusive', () => {
    it('uses Shanghai midnight and an exclusive next-day boundary', () => {
      const range = businessDateRangeInclusive(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z'))
      expect(range.start.toISOString()).toBe('2026-08-31T16:00:00.000Z')
      expect(range.end.toISOString()).toBe('2026-09-29T16:00:00.000Z')
      expect(range.endExclusive.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    })
  })

  it('interprets DATE values using Shanghai day boundaries', () => {
    const range = businessDateOnlyRange(new Date('2026-10-20T00:00:00Z'))
    expect(range.start.toISOString()).toBe('2026-10-19T16:00:00.000Z')
    expect(range.endExclusive.toISOString()).toBe('2026-10-20T16:00:00.000Z')
  })

  describe('businessPeriodToDateRange', () => {
    it('uses Shanghai day and exclusive next midnight', () => {
      const range = businessPeriodToDateRange('2026-11-16', 'DAY')
      expect(range.start.toISOString()).toBe('2026-11-15T16:00:00.000Z')
      expect(range.endExclusive.toISOString()).toBe('2026-11-16T16:00:00.000Z')
    })

    it('uses ISO Monday and stops at the selected Sunday rather than reading the future', () => {
      const range = businessPeriodToDateRange('2026-11-22', 'WEEK')
      expect(range.start.toISOString()).toBe('2026-11-15T16:00:00.000Z')
      expect(range.endExclusive.toISOString()).toBe('2026-11-22T16:00:00.000Z')
    })

    it('keeps Monday as the first day and month at Shanghai midnight', () => {
      expect(businessPeriodToDateRange('2026-11-16', 'WEEK').start.toISOString()).toBe('2026-11-15T16:00:00.000Z')
      expect(businessPeriodToDateRange('2026-11-30', 'MONTH').start.toISOString()).toBe('2026-10-31T16:00:00.000Z')
    })

    it('does not inherit Los Angeles DST when building Shanghai date boundaries', () => {
      const originalTimezone = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
      try {
        for (const key of ['2026-03-08', '2026-11-01']) {
          const dateOnly = businessDateOnlyRange(key)
          const day = businessPeriodToDateRange(key, 'DAY')
          expect(day).toEqual(dateOnly)
          expect(day.start.toISOString().endsWith('T16:00:00.000Z')).toBe(true)
          expect(day.endExclusive.getTime() - day.start.getTime()).toBe(24 * 60 * 60 * 1000)
        }
        expect(businessPeriodToDateRange('2026-03-08', 'WEEK')).toEqual({
          start: new Date('2026-03-01T16:00:00.000Z'), endExclusive: new Date('2026-03-08T16:00:00.000Z'),
        })
        expect(businessPeriodToDateRange('2026-11-01', 'WEEK')).toEqual({
          start: new Date('2026-10-25T16:00:00.000Z'), endExclusive: new Date('2026-11-01T16:00:00.000Z'),
        })
        expect(businessPeriodToDateRange('2026-03-08', 'MONTH').start.toISOString()).toBe('2026-02-28T16:00:00.000Z')
        expect(businessPeriodToDateRange('2026-11-01', 'MONTH').start.toISOString()).toBe('2026-10-31T16:00:00.000Z')
        expect(businessDateRangeInclusive('2026-11-01', '2026-11-01').endExclusive.toISOString()).toBe('2026-11-01T16:00:00.000Z')
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ
        else process.env.TZ = originalTimezone
      }
    })
  })

  describe('businessCompactTimestampKey', () => {
    it('renders 14-digit Shanghai wall-clock for CMB yurRef contracts', () => {
      expect(businessCompactTimestampKey(new Date('2026-08-14T16:30:05Z'))).toBe('20260815003005')
      expect(businessCompactTimestampKey(new Date('2026-08-14T16:30:05Z'))).toHaveLength(14)
    })
  })
})
