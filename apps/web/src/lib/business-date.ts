/** Shanghai business dates, independent of the browser's timezone. */
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function businessDateKey(value: Date | string | number = new Date()): string {
  const date = new Date(value instanceof Date ? value.getTime() : value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function businessMonthKey(value: Date | string | number = new Date()): string {
  return businessDateKey(value).slice(0, 7)
}

/** datetime-local has no timezone; the displayed and entered clock is Beijing. */
export function businessDateTimeInput(value: Date | string | number = new Date()): string {
  const date = new Date(value instanceof Date ? value.getTime() : value)
  if (Number.isNaN(date.getTime())) return ''
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(date)
  return `${businessDateKey(date)}T${time}`
}

export function businessDateTimeToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return ''
  const date = new Date(`${value}:00+08:00`)
  // Round-trip rejects normalized invalid dates and 24:00 rather than moving them.
  return Number.isFinite(date.getTime()) && businessDateTimeInput(date) === value ? date.toISOString() : ''
}

export function monthDateKeys(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式应为 YYYY-MM')
  const [year, number] = month.split('-').map(Number)
  return { from: `${month}-01`, to: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) }
}

export function businessMonthBounds(month: string) {
  const { from, to } = monthDateKeys(month)
  return { start: new Date(`${from}T00:00:00+08:00`).toISOString(),
    endExclusive: new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400_000).toISOString() }
}
