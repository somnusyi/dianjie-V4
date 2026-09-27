export type NotificationRouteInput = {
  refType: string | null
  refId: string | null
}

export const NOTIFICATION_TYPE_LABEL: Record<string, string> = {
  ORDER_SUBMITTED: '新订单',
  ORDER_SHIPPED: '已发货',
  RECEIPT_CONFIRMED: '已收货',
  LOSS_CLAIM_RESULT: '报损',
  APPROVAL_PENDING: '待审批',
  APPROVAL_DONE: '审批完成',
  PAYMENT_DONE: '付款',
  UPSTREAM_SETTLEMENT_CONFIRMED: '上游对账待锁定',
}

// 按角色路由 — 同一 refType 不同角色看不同页，避免跨工作区或点到 404。
export function notificationRefLink(n: NotificationRouteInput, role: string): string | null {
  if (!n.refType || !n.refId) return null
  const isSupplier = role === 'SUPPLIER_OWNER' || role === 'SUPPLIER_STAFF' || role === 'SUPPLIER_SUB'
  const isStore = role === 'MANAGER' || role === 'SUPERVISOR' || role === 'KITCHEN_LEAD' || role === 'PURCHASER'
  const isChef = role === 'CHEF_DIRECTOR' || role === 'CHEF'
  const isFinBoss = role === 'FINANCE' || role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'BOSS'

  if (n.refType === 'PurchaseOrder') {
    if (isSupplier) return `/v2/supplier/orders/${n.refId}`
    if (isStore) return `/v2/chef/purchase/po-success/${n.refId}`
    if (isFinBoss) return `/v2/supplier/orders/${n.refId}`
    return `/v2/supplier/orders/${n.refId}`
  }
  if (n.refType === 'LossClaim') {
    if (isChef) return '/v2/chef-director/disputes'
    if (isSupplier) return '/v2/supplier/orders'
    if (isStore) return '/v2/chef/check'
    return '/v2/chef-director/loss'
  }
  if (n.refType === 'Document') return '/v2/chef-director/approvals'
  if (n.refType === 'PaymentSchedule') return '/v2/finance/home'
  if (n.refType === 'UpstreamSettlementStatement') {
    if (isFinBoss) return `/v2/finance-pc/upstream-settlements?statementId=${encodeURIComponent(n.refId)}`
    return null
  }
  if (n.refType === 'Receipt') {
    if (isSupplier) return '/v2/supplier/billing'
    return '/v2/finance/home'
  }
  return null
}
