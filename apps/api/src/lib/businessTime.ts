/**
 * 业务时区工具：单号月份、期间、归属日的唯一权威来源。
 *
 * 背景：dayjs() 默认按宿主机本地时区解释时间，导致
 *   - 开发/CI 机时区非华东时，月度单号序列错月（DOC202607000001）；
 *   - 传入 UTC 时间戳（receivedAt/confirmedAt）在上海月末 16:00Z 后错月。
 * 所有月度序列号与业务归属日必须经由本模块，禁止在业务代码里直接
 * dayjs(at).format('YYYYMM')。
 *
 * 刻意不做成环境变量：业务月份契约必须全局唯一，不允许按部署环境漂移。
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

/** 业务时区：全部门店与仓库均在华东。 */
export const BUSINESS_TZ = 'Asia/Shanghai'

/** 单号月份键 YYYYMM（业务时区）。 */
export function businessMonthKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMM')
}

/** 业务日期键 YYYY-MM-DD（业务时区），用于导出文件名与归属日展示。 */
export function businessDateKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYY-MM-DD')
}

function calendarDateKey(value: Date | string, dateMeansPostgresDate = false) {
  if (value instanceof Date) return dateMeansPostgresDate ? value.toISOString().slice(0, 10) : businessDateKey(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return businessDateKey(value)
}

function utcCalendarDay(key: string) {
  const value = dayjs.utc(`${key}T00:00:00.000Z`)
  if (!value.isValid() || value.format('YYYY-MM-DD') !== key) throw new Error('业务日期无效')
  return value
}

function shanghaiMidnight(key: string) {
  return dayjs.tz(key, BUSINESS_TZ).toDate()
}

/** A PostgreSQL DATE encodes a business day at UTC midnight, not an instant. */
export function businessDateOnlyRange(date: Date | string) {
  const key = calendarDateKey(date, true)
  const calendar = utcCalendarDay(key)
  return {
    start: shanghaiMidnight(key),
    endExclusive: shanghaiMidnight(calendar.add(1, 'day').format('YYYY-MM-DD')),
  }
}

export type BusinessPeriodUnit = 'DAY' | 'WEEK' | 'MONTH'

/**
 * Build a Shanghai-business period ending at the exclusive midnight after the
 * selected count day. WEEK follows ISO Monday; MONTH never reads future days.
 */
export function businessPeriodToDateRange(date: Date | string, unit: BusinessPeriodUnit) {
  const key = calendarDateKey(date, true)
  const countDay = utcCalendarDay(key)
  const startKey = unit === 'DAY'
    ? key
    : unit === 'MONTH'
      ? countDay.startOf('month').format('YYYY-MM-DD')
      : countDay.subtract((countDay.day() + 6) % 7, 'day').format('YYYY-MM-DD')
  const endKey = countDay.add(1, 'day').format('YYYY-MM-DD')
  return { start: shanghaiMidnight(startKey), endExclusive: shanghaiMidnight(endKey) }
}

/** 业务时间戳 YYYYMMDD_HHmmss（业务时区），用于导出文件名。 */
export function businessTimestampKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMMDD_HHmmss')
}

/** 紧凑业务时间戳 YYYYMMDDHHmmss（业务时区），用于招行 yurRef 等定长契约。 */
export function businessCompactTimestampKey(at: Date | string | number = new Date()): string {
  return dayjs(at).tz(BUSINESS_TZ).format('YYYYMMDDHHmmss')
}

/**
 * 把两个业务日转换为 [start, endExclusive) 的 timestamptz 查询边界。
 * 例如上海 9 月 1 日对应 UTC 8 月 31 日 16:00，避免月初/月底漏单。
 */
export function businessDateRangeInclusive(start: Date | string, end: Date | string) {
  const startKey = calendarDateKey(start)
  const endKey = calendarDateKey(end)
  const endDay = utcCalendarDay(endKey)
  return {
    start: shanghaiMidnight(startKey),
    end: shanghaiMidnight(endKey),
    endExclusive: shanghaiMidnight(endDay.add(1, 'day').format('YYYY-MM-DD')),
  }
}
