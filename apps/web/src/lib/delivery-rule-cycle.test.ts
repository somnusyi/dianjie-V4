import { describe, expect, it } from 'vitest'
import { deliveryOrderDayProjection, deliveryScheduleText, isDeliveryScheduleDate, nextDeliveryScheduleDates } from './delivery-rule-cycle'

describe('配送班表送货规则前端预览', () => {
  it('按星期送货支持多选', () => {
    const rule = { deliveryScheduleMode: 'WEEKLY', weekdays: [1, 3, 5] }
    expect(deliveryScheduleText(rule)).toBe('周一、周三、周五')
    expect(isDeliveryScheduleDate(rule, '2026-09-07')).toBe(true)
    expect(isDeliveryScheduleDate(rule, '2026-09-08')).toBe(false)
  })

  it('每隔 1 天从用户选择的送货起算日开始', () => {
    const rule = { deliveryScheduleMode: 'INTERVAL', deliveryIntervalDays: 1, deliveryIntervalStart: '2026-09-06' }
    expect(deliveryScheduleText(rule)).toBe('每隔 1 天')
    expect(isDeliveryScheduleDate(rule, '2026-09-07')).toBe(false)
    expect(nextDeliveryScheduleDates(rule, '2026-09-06', 4)).toEqual(['2026-09-06', '2026-09-08', '2026-09-10', '2026-09-12'])
  })

  it('最多支持间隔 6 天', () => {
    const rule = { deliveryScheduleMode: 'INTERVAL', deliveryIntervalDays: 6, deliveryIntervalStart: '2026-09-01' }
    expect(nextDeliveryScheduleDates(rule, '2026-09-02', 2)).toEqual(['2026-09-08', '2026-09-15'])
    expect(isDeliveryScheduleDate({ deliveryScheduleMode: 'INTERVAL', deliveryIntervalDays: 7, deliveryIntervalStart: '2026-09-01' }, '2026-09-01')).toBe(false)
  })

  it('逐日显示下单时段并映射到第 N 个送货日', () => {
    const rule = { deliveryScheduleMode: 'WEEKLY', weekdays: [1, 3, 5], leadDays: 2, orderWindowStart: '08:00', orderWindowEnd: '18:00', status: 'ENABLED' }
    expect(deliveryOrderDayProjection(rule, '2026-09-08')).toEqual({ arrivalDate: '2026-09-11', windowLabel: '08:00～18:00' })
  })

  it('全天规则仍显示下单日，停用和生效区间外不显示', () => {
    const rule = { deliveryScheduleMode: 'WEEKLY', weekdays: [1], leadDays: 1, effectiveFrom: '2026-09-08', effectiveTo: '2026-09-30', status: 'ENABLED' }
    expect(deliveryOrderDayProjection(rule, '2026-09-08')).toEqual({ arrivalDate: '2026-09-14', windowLabel: '全天' })
    expect(deliveryOrderDayProjection(rule, '2026-09-07')).toBeNull()
    expect(deliveryOrderDayProjection({ ...rule, status: 'DISABLED' }, '2026-09-08')).toBeNull()
  })
})
