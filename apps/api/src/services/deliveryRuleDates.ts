/**
 * 配送班表日期计算：送货日判定、最快到货日、订货时段。
 * 唯一权威口径，API 与前端共用同一语义：
 *   到货日 = 下单日之后第 leadDays 个送货日（不含下单当天）。
 * 所有星期判定按业务时区 Asia/Shanghai 的日历日。
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { BUSINESS_TZ } from '../lib/businessTime'

dayjs.extend(utc)
dayjs.extend(timezone)

export type DeliveryRuleShape = {
  weekdays: number[]
  leadDays: number
  orderWindowStart: string | null
  orderWindowEnd: string | null
  effectiveFrom: Date | string | null
  effectiveTo: Date | string | null
}

/** dayjs 星期（0=周日）→ 班表口径（1=周一 … 7=周日） */
export function isoWeekday(dateKey: string): number {
  return ((dayjs.tz(`${dateKey}T12:00:00`, BUSINESS_TZ).day() + 6) % 7) + 1
}

/** 规则在该日期是否处于生效区间（含首尾；空端=不限） */
export function isEffectiveOn(rule: DeliveryRuleShape, dateKey: string): boolean {
  if (rule.effectiveFrom && dateKey < dayjs(rule.effectiveFrom).tz(BUSINESS_TZ).format('YYYY-MM-DD')) return false
  if (rule.effectiveTo && dateKey > dayjs(rule.effectiveTo).tz(BUSINESS_TZ).format('YYYY-MM-DD')) return false
  return true
}

/** 该日期是否是送货日（只看星期，不看生效区间） */
export function isDeliveryDay(rule: DeliveryRuleShape, dateKey: string): boolean {
  return rule.weekdays.includes(isoWeekday(dateKey))
}

/** 从 fromDateKey 次日开始往后数 count 个送货日（严格晚于 fromDateKey） */
export function nextDeliveryDates(rule: DeliveryRuleShape, fromDateKey: string, count: number): string[] {
  const dates: string[] = []
  let cursor = dayjs.tz(`${fromDateKey}T12:00:00`, BUSINESS_TZ)
  // 上限保护：班表至少一周一个送货日，60 天内必然找齐；找不到说明配置异常
  for (let i = 0; i < 60 && dates.length < count; i += 1) {
    cursor = cursor.add(1, 'day')
    const key = cursor.format('YYYY-MM-DD')
    if (isDeliveryDay(rule, key) && isEffectiveOn(rule, key)) dates.push(key)
  }
  return dates
}

/** 最快到货日：下单日之后第 leadDays 个送货日；无配置/找不到返回 null */
export function earliestArrivalDate(rule: DeliveryRuleShape, orderDateKey: string): string | null {
  const dates = nextDeliveryDates(rule, orderDateKey, Math.max(1, rule.leadDays))
  return dates[Math.max(1, rule.leadDays) - 1] || null
}

/** 下单时刻是否落在允许订货时段内（时段为空=全天允许；支持跨零点如 20:00~02:00） */
export function isWithinOrderWindow(rule: DeliveryRuleShape, at: Date = new Date()): boolean {
  if (!rule.orderWindowStart || !rule.orderWindowEnd) return true
  const hhmm = dayjs(at).tz(BUSINESS_TZ).format('HH:mm')
  if (rule.orderWindowStart <= rule.orderWindowEnd) {
    return hhmm >= rule.orderWindowStart && hhmm <= rule.orderWindowEnd
  }
  return hhmm >= rule.orderWindowStart || hhmm <= rule.orderWindowEnd
}
