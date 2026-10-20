const TERMINAL = new Set(['DRAFT', 'RECEIVED', 'SETTLEMENT_PENDING', 'CLOSED', 'SETTLED', 'COMPLETED', 'CANCELLED', 'REJECTED'])
function calendarDate(raw: string): string | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|T)/.exec(raw.trim())
  if (!match) return null
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const time = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : null
}
export function purchaseOrderOverdueText(order: {expectedArrivalAt?: string | null; status: string}, now = new Date()): string | null {
  if (!order.expectedArrivalAt || TERMINAL.has(order.status)) return null
  const due = calendarDate(order.expectedArrivalAt)
  if (!due || !Number.isFinite(now.getTime())) return null
  const today = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).format(now)
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000)
  return Number.isFinite(days) && days > 0 ? `逾期 ${days} 天` : null
}
