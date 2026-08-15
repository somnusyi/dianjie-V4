import { describe, expect, it } from 'vitest'
import {
  BUSINESS_TZ,
  businessCompactTimestampKey,
  businessDateKey,
  businessMonthKey,
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

  describe('businessCompactTimestampKey', () => {
    it('renders 14-digit Shanghai wall-clock for CMB yurRef contracts', () => {
      expect(businessCompactTimestampKey(new Date('2026-08-14T16:30:05Z'))).toBe('20260815003005')
      expect(businessCompactTimestampKey(new Date('2026-08-14T16:30:05Z'))).toHaveLength(14)
    })
  })
})
