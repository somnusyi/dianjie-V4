import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

const BUSINESS_TZ = 'Asia/Shanghai'

export type DeliveryScheduleLike = {
  deliveryScheduleMode?: string
  weekdays?: number[]
  deliveryIntervalDays?: number | null
  deliveryIntervalStart?: Date | string | null
}

function businessDateKey(value: Date | string): string {
  return dayjs(value).tz(BUSINESS_TZ).format('YYYY-MM-DD')
}

export function deliveryScheduleText(rule: DeliveryScheduleLike): string {
  if (rule.deliveryScheduleMode === 'INTERVAL') return `每隔 ${rule.deliveryIntervalDays} 天`
  const names = ['', '一', '二', '三', '四', '五', '六', '日']
  return (rule.weekdays || []).map(day => `周${names[day]}`).join('、')
}

export function isDeliveryScheduleDate(rule: DeliveryScheduleLike, dateKey: string): boolean {
  if (rule.deliveryScheduleMode !== 'INTERVAL') {
    const weekday = ((dayjs.tz(`${dateKey}T12:00:00`, BUSINESS_TZ).day() + 6) % 7) + 1
    return (rule.weekdays || []).includes(weekday)
  }
  if (!Number.isInteger(rule.deliveryIntervalDays)
    || !rule.deliveryIntervalDays
    || rule.deliveryIntervalDays < 1
    || rule.deliveryIntervalDays > 6
    || !rule.deliveryIntervalStart) return false
  const startKey = businessDateKey(rule.deliveryIntervalStart)
  if (dateKey < startKey) return false
  const start = dayjs.tz(`${startKey}T12:00:00`, BUSINESS_TZ)
  const current = dayjs.tz(`${dateKey}T12:00:00`, BUSINESS_TZ)
  return current.diff(start, 'day') % (rule.deliveryIntervalDays + 1) === 0
}

export function nextDeliveryScheduleDates(rule: DeliveryScheduleLike, fromDateKey: string, count: number): string[] {
  const dates: string[] = []
  let cursor = dayjs.tz(`${fromDateKey}T12:00:00`, BUSINESS_TZ)
  for (let i = 0; i < 120 && dates.length < count; i += 1) {
    const key = cursor.format('YYYY-MM-DD')
    if (isDeliveryScheduleDate(rule, key)) dates.push(key)
    cursor = cursor.add(1, 'day')
  }
  return dates
}
