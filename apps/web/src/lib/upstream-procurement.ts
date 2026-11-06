import { businessMonthKey, monthDateKeys } from './business-date'
export type UpstreamOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'SUBMITTED_TO_SUPPLIER'
  | 'SUPPLIER_ACCEPTED'
  | 'CHANGE_PROPOSED'
  | 'PARTIALLY_SHIPPED'
  | 'SHIPPED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'SETTLEMENT_PENDING'
  | 'SETTLED'
  | 'CANCELLED'

export const UPSTREAM_ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待内部审核',
  SUBMITTED_TO_SUPPLIER: '待供应商接单',
  SUPPLIER_ACCEPTED: '供应商已接单',
  CHANGE_PROPOSED: '供应商改单待审核',
  PARTIALLY_SHIPPED: '部分发货',
  SHIPPED: '已发货',
  PARTIALLY_RECEIVED: '部分收货',
  RECEIVED: '已完成收货',
  SETTLEMENT_PENDING: '待对账',
  SETTLED: '已结算',
  CLOSED: '已关闭',
  CANCELLED: '已取消',
}

export const UPSTREAM_RECEIPT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '待验收',
  INSPECTING: '验收中',
  PENDING_REVIEW: '待复核',
  POSTED: '已入库',
  REVERSED: '已冲销',
}

export const UPSTREAM_CLAIM_STATUS_LABEL: Record<string, string> = {
  PENDING_SUPPLIER: '待供应商确认',
  SUPPLIER_ACCEPTED: '供应商已接受',
  SUPPLIER_REJECTED: '供应商有异议',
  AUTO_ACCEPTED: '超时自动接受',
  ARBITRATION: '仲裁中',
  RESOLVED: '已办结',
  CANCELLED: '已取消',
}

export const UPSTREAM_SETTLEMENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  SENT_TO_SUPPLIER: '待供应商确认',
  DISPUTED: '供应商有异议',
  CONFIRMED: '双方已确认',
  LOCKED: '已锁定',
  INVOICED: '已关联发票',
  PAID: '已付款',
  CANCELLED: '已取消',
}

export function money(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(amount)
    : '—'
}

function settlementAmountUnits(value: unknown): bigint | null {
  const text = String(value ?? '').trim()
  const match = text.length <= 64 && text.match(/^([+-]?)(\d+)(?:\.(\d{1,4}))?$/)
  if (!match) return null
  const units = BigInt(match[2]) * BigInt(10000) + BigInt((match[3] || '').padEnd(4, '0'))
  return match[1] === '-' ? -units : units
}

/** Statement amounts are recorded at four places; never hide their stored tail. */
export function settlementMoney(value: unknown) {
  const units = settlementAmountUnits(value)
  if (units === null) return '—'
  const text = (units < BigInt(0) ? -units : units).toString().padStart(5, '0')
  const integer = text.slice(0, -4).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = text.slice(-4).replace(/0+$/, '').padEnd(2, '0')
  return `${units < BigInt(0) ? '-' : ''}¥${integer}.${fraction}`
}

/** Avoid binary-floating-point or unsafe-integer loss in statement summaries. */
export function sumSettlementAmounts(values: unknown[]) {
  let total = BigInt(0)
  for (const value of values) {
    const units = settlementAmountUnits(value)
    if (units === null) return '—'
    total += units
  }
  const text = (total < BigInt(0) ? -total : total).toString().padStart(5, '0')
  return `${total < BigInt(0) ? '-' : ''}${text.slice(0, -4)}.${text.slice(-4)}`
}

/** Unit prices retain the same six-decimal precision accepted by procurement forms. */
export function unitPriceMoney(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount)
    : '—'
}

export function shortDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

export function statusTone(status: string) {
  if (['POSTED', 'RECEIVED', 'SETTLED', 'PAID', 'LOCKED', 'SUPPLIER_ACCEPTED'].includes(status)) return 'bg-green/10 text-green'
  if (['CANCELLED', 'REVERSED', 'SUPPLIER_REJECTED', 'DISPUTED'].includes(status)) return 'bg-red-50 text-red-700'
  if (['PENDING_REVIEW', 'CHANGE_PROPOSED', 'ARBITRATION'].includes(status)) return 'bg-amber/15 text-amber-fg'
  return 'bg-bg text-gray2'
}

export function currentMonthRange(now = new Date()) {
  const { from: start, to: end } = monthDateKeys(businessMonthKey(now))
  return { start, end }
}

export type ReceiptReviewAction = 'confirm' | 'review' | null

/** Pick the valid next UI action when an idempotent receipt request is replayed. */
export function receiptReviewActionForStatus(status: string): ReceiptReviewAction {
  if (status === 'INSPECTING') return 'confirm'
  if (status === 'PENDING_REVIEW') return 'review'
  return null
}

/** A failed post-success refresh must never turn a completed mutation into a retryable failure. */
export async function loadCreatedRecord<T extends { id: string }>(
  id: string,
  load: () => Promise<T[]>,
): Promise<{ rows: T[]; record: T } | null> {
  try {
    const rows = await load()
    const record = rows.find(item => item.id === id)
    return record ? { rows, record } : null
  } catch {
    return null
  }
}
