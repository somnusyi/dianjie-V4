/**
 * 上游采购领域状态机。
 *
 * 这里刻意不依赖 Fastify、Prisma 或页面状态，所有命令入口必须先通过本文件，
 * 避免供应链端和供应商端各自实现一套可漂移的状态判断。
 */

export const UPSTREAM_PO_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'SUBMITTED_TO_SUPPLIER',
  'CHANGE_PROPOSED',
  'SUPPLIER_ACCEPTED',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'SETTLEMENT_PENDING',
  'CLOSED',
  'CANCELLED',
] as const

export type UpstreamPurchaseOrderStatus = typeof UPSTREAM_PO_STATUSES[number]

export const UPSTREAM_RECEIPT_STATUSES = [
  'DRAFT',
  'INSPECTING',
  'PENDING_REVIEW',
  'POSTED',
  'REVERSED',
] as const

export type UpstreamReceiptStatus = typeof UPSTREAM_RECEIPT_STATUSES[number]

export const UPSTREAM_CLAIM_STATUSES = [
  'PENDING_SUPPLIER',
  'SUPPLIER_ACCEPTED',
  'SUPPLIER_REJECTED',
  'ARBITRATION',
  'AUTO_ACCEPTED',
  'RESOLVED',
  'CANCELLED',
] as const

export type UpstreamArrivalClaimStatus = typeof UPSTREAM_CLAIM_STATUSES[number]

export const UPSTREAM_SETTLEMENT_STATUSES = [
  'DRAFT',
  'SENT_TO_SUPPLIER',
  'DISPUTED',
  'CONFIRMED',
  'LOCKED',
  'INVOICED',
  'PAID',
  'CANCELLED',
] as const

export type UpstreamSettlementStatus = typeof UPSTREAM_SETTLEMENT_STATUSES[number]

type TransitionMap<T extends string> = Readonly<Record<T, readonly T[]>>

const purchaseOrderTransitions: TransitionMap<UpstreamPurchaseOrderStatus> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['DRAFT', 'SUBMITTED_TO_SUPPLIER', 'CANCELLED'],
  SUBMITTED_TO_SUPPLIER: ['CHANGE_PROPOSED', 'SUPPLIER_ACCEPTED', 'CANCELLED'],
  CHANGE_PROPOSED: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'CANCELLED'],
  SUPPLIER_ACCEPTED: ['CHANGE_PROPOSED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED'],
  PARTIALLY_SHIPPED: ['CHANGE_PROPOSED', 'SHIPPED', 'PARTIALLY_RECEIVED'],
  SHIPPED: ['PARTIALLY_RECEIVED', 'RECEIVED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_SHIPPED', 'SHIPPED', 'RECEIVED'],
  RECEIVED: ['SETTLEMENT_PENDING'],
  SETTLEMENT_PENDING: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
}

const receiptTransitions: TransitionMap<UpstreamReceiptStatus> = {
  DRAFT: ['INSPECTING'],
  INSPECTING: ['DRAFT', 'PENDING_REVIEW', 'POSTED'],
  PENDING_REVIEW: ['INSPECTING', 'POSTED'],
  POSTED: ['REVERSED'],
  REVERSED: [],
}

const claimTransitions: TransitionMap<UpstreamArrivalClaimStatus> = {
  PENDING_SUPPLIER: ['SUPPLIER_ACCEPTED', 'SUPPLIER_REJECTED', 'AUTO_ACCEPTED', 'CANCELLED'],
  SUPPLIER_ACCEPTED: ['RESOLVED'],
  SUPPLIER_REJECTED: ['ARBITRATION'],
  ARBITRATION: ['RESOLVED'],
  AUTO_ACCEPTED: ['RESOLVED'],
  RESOLVED: [],
  CANCELLED: [],
}

const settlementTransitions: TransitionMap<UpstreamSettlementStatus> = {
  DRAFT: ['SENT_TO_SUPPLIER', 'CANCELLED'],
  SENT_TO_SUPPLIER: ['DISPUTED', 'CONFIRMED'],
  DISPUTED: ['SENT_TO_SUPPLIER', 'CONFIRMED'],
  CONFIRMED: ['LOCKED'],
  LOCKED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: [],
  CANCELLED: [],
}

export class InvalidUpstreamTransitionError extends Error {
  constructor(entity: string, from: string, to: string) {
    super(`${entity} 不允许从 ${from} 变更为 ${to}`)
    this.name = 'InvalidUpstreamTransitionError'
  }
}

export class UpstreamReceiptReviewerConflictError extends Error {
  constructor() {
    super('上游收货复核人必须与验收人不同')
    this.name = 'UpstreamReceiptReviewerConflictError'
  }
}

function assertTransition<T extends string>(
  entity: string,
  transitions: TransitionMap<T>,
  from: T,
  to: T,
) {
  if (!transitions[from].includes(to)) {
    throw new InvalidUpstreamTransitionError(entity, from, to)
  }
}

export function assertUpstreamPurchaseOrderTransition(
  from: UpstreamPurchaseOrderStatus,
  to: UpstreamPurchaseOrderStatus,
) {
  assertTransition('上游采购单', purchaseOrderTransitions, from, to)
}

export function assertUpstreamReceiptTransition(from: UpstreamReceiptStatus, to: UpstreamReceiptStatus) {
  assertTransition('上游收货单', receiptTransitions, from, to)
}

export function assertUpstreamArrivalClaimTransition(
  from: UpstreamArrivalClaimStatus,
  to: UpstreamArrivalClaimStatus,
) {
  assertTransition('上游到货差异单', claimTransitions, from, to)
}

export function assertUpstreamSettlementTransition(
  from: UpstreamSettlementStatus,
  to: UpstreamSettlementStatus,
) {
  assertTransition('上游对账单', settlementTransitions, from, to)
}

export type UpstreamReceiptReviewInput = {
  payableAmount: number
  reviewAmountThreshold: number
  hasOverReceipt: boolean
  hasTemporaryPrice: boolean
  hasSensitiveCategory: boolean
}

export type UpstreamReceiptReviewReason =
  | 'AMOUNT_THRESHOLD'
  | 'OVER_RECEIPT'
  | 'TEMPORARY_PRICE'
  | 'SENSITIVE_CATEGORY'

/** 普通收货单人确认；命中任一风险条件则必须由不同用户复核。 */
export function upstreamReceiptReviewReasons(input: UpstreamReceiptReviewInput): UpstreamReceiptReviewReason[] {
  const reasons: UpstreamReceiptReviewReason[] = []
  if (input.reviewAmountThreshold >= 0 && input.payableAmount >= input.reviewAmountThreshold) {
    reasons.push('AMOUNT_THRESHOLD')
  }
  if (input.hasOverReceipt) reasons.push('OVER_RECEIPT')
  if (input.hasTemporaryPrice) reasons.push('TEMPORARY_PRICE')
  if (input.hasSensitiveCategory) reasons.push('SENSITIVE_CATEGORY')
  return reasons
}

export function requiresUpstreamReceiptReview(input: UpstreamReceiptReviewInput) {
  return upstreamReceiptReviewReasons(input).length > 0
}

export function assertDifferentReceiptReviewer(inspectorId: string, reviewerId: string) {
  if (inspectorId === reviewerId) {
    throw new UpstreamReceiptReviewerConflictError()
  }
}
