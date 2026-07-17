export type SupplierStatusTone = 'red' | 'orange' | 'gray' | 'green'

export type SupplierOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'DELIVERING'
  | 'PENDING_CONFIRM'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED'

export type SupplierDeliveryStatus =
  | 'DRAFT'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'RECEIVED'
  | 'CANCELLED'

export type SupplierOrderBucket = 'pending' | 'to_ship' | 'shipping' | 'completed' | 'other'

export type SupplierLossClaimKind =
  | 'ARRIVAL_SHORTAGE'
  | 'ARRIVAL_DAMAGE'
  | 'INTERNAL_WASTE'
  | 'LEGACY_UNRESOLVED'

type StatusMeta = {
  label: string
  detailLabel: string
  tone: SupplierStatusTone
  progressStep: number
  terminal: boolean
}

const ORDER_STATUS_META: Record<SupplierOrderStatus, StatusMeta> = {
  DRAFT: { label: '草稿', detailLabel: '草稿', tone: 'gray', progressStep: 0, terminal: false },
  SUBMITTED: { label: '待接单', detailLabel: '待接单', tone: 'red', progressStep: 1, terminal: false },
  CONFIRMED: { label: '待发货', detailLabel: '已接单，待核对实发', tone: 'orange', progressStep: 2, terminal: false },
  DELIVERING: { label: '配送中', detailLabel: '配送中（在途）', tone: 'orange', progressStep: 3, terminal: false },
  PENDING_CONFIRM: { label: '待门店收货', detailLabel: '已送达，待门店确认收货', tone: 'orange', progressStep: 4, terminal: false },
  RECEIVED: { label: '已收货', detailLabel: '门店已确认收货', tone: 'green', progressStep: 5, terminal: true },
  COMPLETED: { label: '已完成', detailLabel: '订单已完成', tone: 'green', progressStep: 5, terminal: true },
  CANCELLED: { label: '已取消', detailLabel: '订单已取消', tone: 'gray', progressStep: 0, terminal: true },
}

const DELIVERY_STATUS_META: Record<SupplierDeliveryStatus, Omit<StatusMeta, 'progressStep'>> = {
  DRAFT: { label: '草稿', detailLabel: '配送单草稿', tone: 'gray', terminal: false },
  SHIPPED: { label: '已发货', detailLabel: '货物已发出', tone: 'orange', terminal: false },
  DELIVERED: { label: '已送达', detailLabel: '已送达门店', tone: 'orange', terminal: false },
  RECEIVED: { label: '已收货', detailLabel: '门店已确认收货', tone: 'green', terminal: true },
  CANCELLED: { label: '已取消', detailLabel: '配送单已取消', tone: 'gray', terminal: true },
}

// 兼容读取早期页面曾写错的 CANCELED；所有新写入和 API 仍只使用 CANCELLED。
export function normalizeSupplierOrderStatus(status: string): SupplierOrderStatus | null {
  const normalized = status === 'CANCELED' ? 'CANCELLED' : status
  return normalized in ORDER_STATUS_META ? normalized as SupplierOrderStatus : null
}

export function supplierOrderStatusMeta(status: string): StatusMeta {
  const normalized = normalizeSupplierOrderStatus(status)
  return normalized
    ? ORDER_STATUS_META[normalized]
    : { label: status || '未知状态', detailLabel: status || '未知状态', tone: 'gray', progressStep: 0, terminal: false }
}

export function supplierDeliveryStatusMeta(status: string) {
  const normalized = status === 'CANCELED' ? 'CANCELLED' : status
  return normalized in DELIVERY_STATUS_META
    ? DELIVERY_STATUS_META[normalized as SupplierDeliveryStatus]
    : { label: status || '未知状态', detailLabel: status || '未知状态', tone: 'gray' as const, terminal: false }
}

export function supplierOrderBucket(status: string): SupplierOrderBucket {
  switch (normalizeSupplierOrderStatus(status)) {
    case 'SUBMITTED': return 'pending'
    case 'CONFIRMED': return 'to_ship'
    case 'DELIVERING':
    case 'PENDING_CONFIRM': return 'shipping'
    case 'RECEIVED':
    case 'COMPLETED':
    case 'CANCELLED': return 'completed'
    default: return 'other'
  }
}

export const SUPPLIER_MONEY_TERMS = {
  orderedAmount: '订货金额',
  shipmentAmount: '实发金额',
  receivedAmount: '实收金额',
  payableAmount: '应付金额',
  paidAmount: '已付金额',
  lossAmount: '报损金额',
} as const

type LossClaimKindMeta = {
  label: string
  quantityLabel: string
  supplierActionLabel: string
}

const LOSS_CLAIM_KIND_META: Record<SupplierLossClaimKind, LossClaimKindMeta> = {
  ARRIVAL_SHORTAGE: {
    label: '到货短缺',
    quantityLabel: '短缺',
    supplierActionLabel: '确认短缺',
  },
  ARRIVAL_DAMAGE: {
    label: '破损 / 品质异常',
    quantityLabel: '不合格',
    supplierActionLabel: '确认差异',
  },
  INTERNAL_WASTE: {
    label: '门店内部报损',
    quantityLabel: '报损',
    supplierActionLabel: '无需供应商处理',
  },
  LEGACY_UNRESOLVED: {
    label: '历史待核',
    quantityLabel: '差异',
    supplierActionLabel: '确认差异',
  },
}

export function supplierLossClaimSettlementHint(payableBasis?: string | null) {
  switch (payableBasis) {
    case 'NET_AT_RECEIPT':
      return '应付金额已按门店实收数量计算；确认后只结案差异，不会再次扣款。'
    case 'GROSS_PENDING_CLAIM':
      return '这是验收后补报，相关账期已冻结；确认后会从当前应付中扣除本次差异金额。'
    case 'NOT_APPLICABLE':
      return '该记录属于门店内部损耗，不调整供应商应付。'
    default:
      return '历史记录缺少明确的应付基准，处理前请核对原始单据。'
  }
}

export function supplierLossClaimKindMeta(kind?: string | null): LossClaimKindMeta {
  return kind && kind in LOSS_CLAIM_KIND_META
    ? LOSS_CLAIM_KIND_META[kind as SupplierLossClaimKind]
    : LOSS_CLAIM_KIND_META.LEGACY_UNRESOLVED
}

export function supplierLossClaimResponsibility(status: string) {
  switch (status) {
    case 'PENDING': return '待供应商确认'
    case 'REJECTED': return '待总厨仲裁'
    case 'NEGOTIATING': return '协商处理中'
    case 'APPROVED': return '供应商已确认'
    case 'AUTO_APPROVED': return '超时自动确认'
    case 'RESOLVED': return '总厨已裁定'
    default: return '已记录'
  }
}
