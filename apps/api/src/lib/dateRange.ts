/**
 * 日期范围 helper (避免 PG DATE 列时区歪斜)
 *
 * 背景:
 *   PG vouchers.date 列是 DATE 类型 (无时间), 但 prisma 把 JS Date 当 timestamptz 发送.
 *   PG 因为参数无类型, 按列类型推断 → 把 timestamptz 隐式转 DATE → **丢时间部分**.
 *   在 Asia/Shanghai (+8) 服务器上 dayjs('2026-05-01').startOf('month').toDate()
 *     = '2026-04-30T16:00:00Z UTC' → PG 丢时间 = '2026-04-30' → 包含 4/30 凭证.
 *
 *   修复: 用 UTC 构造 Date, 强制时间部分落在 UTC 0 点 = 不跨日.
 *     dayjs.utc('2026-05-01').startOf('month').toDate() = '2026-05-01T00:00:00Z'
 *     → PG 丢时间 = '2026-05-01' → 正确不含 4/30.
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
dayjs.extend(utc)

/**
 * 给 PG DATE 列用的月份范围 (避免 timezone 跨日)
 * @param month YYYY-MM 字串, 例 '2026-05'
 */
export function monthRangeForDateCol(month: string): { start: Date; end: Date } {
  return {
    start: dayjs.utc(month + '-01').startOf('month').toDate(),
    end: dayjs.utc(month + '-01').endOf('month').toDate(),
  }
}

/**
 * 给 PG DATE 列用的"截止日"边界
 * @param asOf YYYY-MM-DD 字串或 Date
 */
export function endOfDayUtcForDateCol(asOf: string | Date): Date {
  return dayjs.utc(asOf).endOf('day').toDate()
}
