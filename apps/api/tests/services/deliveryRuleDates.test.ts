import { describe, expect, it } from 'vitest'
import {
  earliestArrivalDate,
  isDeliveryDay,
  isEffectiveOn,
  isWithinOrderWindow,
  isoWeekday,
  nextDeliveryDates,
} from '../../src/services/deliveryRuleDates'

const baseRule = {
  weekdays: [1, 3, 5], // 周一三五送货
  leadDays: 1,
  orderWindowStart: null,
  orderWindowEnd: null,
  effectiveFrom: null,
  effectiveTo: null,
}

describe('配送班表日期计算', () => {
  it('星期口径：1=周一 … 7=周日', () => {
    expect(isoWeekday('2026-08-24')).toBe(1) // 周一
    expect(isoWeekday('2026-08-27')).toBe(4) // 周四
    expect(isoWeekday('2026-08-30')).toBe(7) // 周日
  })

  it('判定送货日', () => {
    expect(isDeliveryDay(baseRule, '2026-08-24')).toBe(true)  // 周一
    expect(isDeliveryDay(baseRule, '2026-08-25')).toBe(false) // 周二
  })

  it('最快到货日 = 下单后第 1 个送货日（不含下单当天）', () => {
    // 周一下单 → 周三到货
    expect(earliestArrivalDate(baseRule, '2026-08-24')).toBe('2026-08-26')
    // 周四下单 → 周五到货
    expect(earliestArrivalDate(baseRule, '2026-08-27')).toBe('2026-08-28')
    // 周日下单 → 周一到货
    expect(earliestArrivalDate(baseRule, '2026-08-30')).toBe('2026-08-31')
  })

  it('leadDays=2 时取第 2 个送货日', () => {
    const rule = { ...baseRule, leadDays: 2 }
    // 周一下单 → 周五到货（跨过周三）
    expect(earliestArrivalDate(rule, '2026-08-24')).toBe('2026-08-28')
  })

  it('生效区间：区间外的送货日不计入', () => {
    const rule = { ...baseRule, effectiveFrom: '2026-08-26', effectiveTo: '2026-08-26' }
    expect(isEffectiveOn(rule, '2026-08-24')).toBe(false)
    expect(isEffectiveOn(rule, '2026-08-26')).toBe(true)
    // 周一下单，周三(8/26)在生效区内 → 当天到货；之后无送货日
    expect(earliestArrivalDate(rule, '2026-08-24')).toBe('2026-08-26')
    expect(nextDeliveryDates(rule, '2026-08-26', 3)).toEqual([])
  })

  it('订货时段：常规时段与跨零点时段', () => {
    const day = { ...baseRule, orderWindowStart: '09:00', orderWindowEnd: '22:00' }
    expect(isWithinOrderWindow(day, new Date('2026-08-27T10:00:00+08:00'))).toBe(true)
    expect(isWithinOrderWindow(day, new Date('2026-08-27T08:59:00+08:00'))).toBe(false)
    const overnight = { ...baseRule, orderWindowStart: '20:00', orderWindowEnd: '02:00' }
    expect(isWithinOrderWindow(overnight, new Date('2026-08-27T23:30:00+08:00'))).toBe(true)
    expect(isWithinOrderWindow(overnight, new Date('2026-08-27T12:00:00+08:00'))).toBe(false)
    // 未配置时段 = 全天允许
    expect(isWithinOrderWindow(baseRule, new Date('2026-08-27T03:00:00+08:00'))).toBe(true)
  })

  it('未来送货日预览按序排列且不含下单当天', () => {
    expect(nextDeliveryDates(baseRule, '2026-08-24', 3)).toEqual(['2026-08-26', '2026-08-28', '2026-08-31'])
  })
})
