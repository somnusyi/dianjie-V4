export const REPLENISHMENT_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'ACCEPTED',
  'FULFILLING',
  'COMPLETED',
  'CANCELLED',
  'EXCEPTION',
] as const

export type ReplenishmentStatus = typeof REPLENISHMENT_STATUSES[number]
export type ReplenishmentStoredStatus = 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'CANCELLED'

export const REPLENISHMENT_TRANSITIONS: Readonly<Record<ReplenishmentStoredStatus, readonly ReplenishmentStoredStatus[]>> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: [],
  CANCELLED: [],
}

export function canTransitionReplenishment(from: ReplenishmentStoredStatus, to: ReplenishmentStoredStatus) {
  return REPLENISHMENT_TRANSITIONS[from].includes(to)
}

export function assertReplenishmentTransition(from: ReplenishmentStoredStatus, to: ReplenishmentStoredStatus) {
  if (!canTransitionReplenishment(from, to)) {
    throw Object.assign(new Error(`补货单不能从 ${from} 变更为 ${to}`), { statusCode: 409 })
  }
}

type FormalOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'DELIVERING'
  | 'PENDING_CONFIRM'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED'

/**
 * The replenishment document remains an independent request. Once accepted,
 * its progress is a read projection of the linked formal purchase order; it
 * never becomes a second source for DeliveryOrder.
 */
export function deriveReplenishmentFulfillmentStatus(input: {
  storedStatus: ReplenishmentStoredStatus
  hasFulfillmentLink: boolean
  linkedOrderStatus?: FormalOrderStatus | null
}): ReplenishmentStatus {
  if (input.storedStatus === 'DRAFT' || input.storedStatus === 'SUBMITTED' || input.storedStatus === 'CANCELLED') {
    if (input.hasFulfillmentLink || input.linkedOrderStatus) return 'EXCEPTION'
    return input.storedStatus
  }
  if (!input.hasFulfillmentLink || !input.linkedOrderStatus || input.linkedOrderStatus === 'CANCELLED') return 'EXCEPTION'
  if (input.linkedOrderStatus === 'DRAFT' || input.linkedOrderStatus === 'SUBMITTED' || input.linkedOrderStatus === 'CONFIRMED') {
    return 'ACCEPTED'
  }
  if (input.linkedOrderStatus === 'COMPLETED') return 'COMPLETED'
  return 'FULFILLING'
}

export function replenishmentNextAction(status: ReplenishmentStatus) {
  if (status === 'DRAFT') return { label: '继续编辑', action: 'EDIT' as const }
  if (status === 'SUBMITTED') return { label: '接单', action: 'ACCEPT' as const }
  if (status === 'ACCEPTED') return { label: '查看订单', action: 'VIEW_ORDER' as const }
  if (status === 'FULFILLING') return { label: '查看配送', action: 'VIEW_FULFILLMENT' as const }
  if (status === 'COMPLETED') return { label: '查看收货', action: 'VIEW_RECEIPT' as const }
  if (status === 'EXCEPTION') return { label: '处理异常', action: 'RESOLVE_EXCEPTION' as const }
  return { label: '查看记录', action: 'VIEW' as const }
}
