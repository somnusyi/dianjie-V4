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

export function shortDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN')
}

export function statusTone(status: string) {
  if (['POSTED', 'RECEIVED', 'SETTLED', 'PAID', 'LOCKED', 'SUPPLIER_ACCEPTED'].includes(status)) return 'bg-green/10 text-green'
  if (['CANCELLED', 'REVERSED', 'SUPPLIER_REJECTED', 'DISPUTED'].includes(status)) return 'bg-red-50 text-red-700'
  if (['PENDING_REVIEW', 'CHANGE_PROPOSED', 'ARBITRATION'].includes(status)) return 'bg-amber/15 text-amber-fg'
  return 'bg-bg text-gray2'
}

export function currentMonthRange(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const lastDay = String(new Date(year, now.getMonth() + 1, 0).getDate()).padStart(2, '0')
  return { start: `${year}-${month}-01`, end: `${year}-${month}-${lastDay}` }
}
