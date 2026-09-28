export type ReplenishmentStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'FULFILLING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXCEPTION'

export type ReplenishmentItem = {
  id?: string
  productId: string
  quantity: number | string
  unitPrice: number | string
  amount: number | string
  productCodeSnapshot?: string | null
  productNameSnapshot: string
  productSpecSnapshot?: string | null
  orderUnitSnapshot: string
}

export type ReplenishmentOrder = {
  id: string
  no: string
  storeId: string
  supplierId: string
  expectedDate: string
  totalAmount: number | string
  status: string
  displayStatus: ReplenishmentStatus
  source: string
  note?: string | null
  rowVersion: number
  createdAt: string
  updatedAt: string
  store: { id: string; no: string; name: string }
  supplier: { id: string; no: string; name: string }
  createdBy: { id: string; name: string; role: string }
  items: ReplenishmentItem[]
  fulfillment?: {
    purchaseOrderId: string
    purchaseOrder: { id: string; no: string; status: string; expectedDate?: string | null }
  } | null
}

export const REPLENISHMENT_STATUS_OPTIONS: Array<{ value: ReplenishmentStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'SUBMITTED', label: '待接单' },
  { value: 'ACCEPTED', label: '已接单' },
  { value: 'FULFILLING', label: '履约中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
  { value: 'EXCEPTION', label: '履约异常' },
]

export function replenishmentStatusLabel(status: ReplenishmentStatus) {
  return REPLENISHMENT_STATUS_OPTIONS.find(option => option.value === status)?.label || status
}

export function replenishmentStatusTone(status: ReplenishmentStatus): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'COMPLETED') return 'green'
  if (status === 'SUBMITTED' || status === 'FULFILLING') return 'orange'
  if (status === 'EXCEPTION') return 'red'
  return 'gray'
}

export function replenishmentItemSummary(items: ReplenishmentItem[]) {
  if (!items.length) return '暂无商品'
  const names = items.slice(0, 3).map(item => item.productNameSnapshot).join('、')
  return items.length > 3 ? `${names} 等${items.length}项` : names
}

export function replenishmentNextStep(order: ReplenishmentOrder) {
  const poNo = order.fulfillment?.purchaseOrder?.no || ''
  switch (order.displayStatus) {
    case 'DRAFT': return { label: '继续编辑', href: `/v2/supply-chain/replenishment-orders/${order.id}` }
    case 'SUBMITTED': return { label: '接单', href: `/v2/supply-chain/replenishment-orders/${order.id}` }
    case 'ACCEPTED': return { label: '查看正式订单', href: `/v2/supply-chain/fulfillment/${order.fulfillment?.purchaseOrderId || ''}` }
    case 'FULFILLING': return { label: '查看配送', href: `/v2/supply-chain/deliveries?keyword=${encodeURIComponent(poNo)}` }
    case 'COMPLETED': return { label: '查看收货', href: `/v2/supply-chain/receipts?keyword=${encodeURIComponent(poNo)}` }
    case 'EXCEPTION': return { label: '处理异常', href: `/v2/supply-chain/replenishment-orders/${order.id}#exception` }
    default: return { label: '查看详情', href: `/v2/supply-chain/replenishment-orders/${order.id}` }
  }
}

export function makeRequestKey(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`.slice(0, 80)
}
