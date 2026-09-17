import { describe, expect, it } from 'vitest'
import {
  InvalidUpstreamTransitionError,
  assertDifferentReceiptReviewer,
  assertUpstreamArrivalClaimTransition,
  assertUpstreamPurchaseOrderTransition,
  assertUpstreamReceiptTransition,
  assertUpstreamSettlementTransition,
  requiresUpstreamReceiptReview,
  upstreamReceiptReviewReasons,
} from '../../src/domain/upstreamProcurement'

describe('upstream procurement state machines', () => {
  it('supports the normal purchase-order lifecycle and blocks skipping supplier acceptance', () => {
    assertUpstreamPurchaseOrderTransition('DRAFT', 'PENDING_APPROVAL')
    assertUpstreamPurchaseOrderTransition('PENDING_APPROVAL', 'SUBMITTED_TO_SUPPLIER')
    assertUpstreamPurchaseOrderTransition('SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED')
    expect(() => assertUpstreamPurchaseOrderTransition('SUBMITTED_TO_SUPPLIER', 'RECEIVED'))
      .toThrow(InvalidUpstreamTransitionError)
  })

  it('never allows a posted receipt to return to an editable state', () => {
    assertUpstreamReceiptTransition('INSPECTING', 'POSTED')
    assertUpstreamReceiptTransition('POSTED', 'REVERSED')
    expect(() => assertUpstreamReceiptTransition('POSTED', 'DRAFT'))
      .toThrow('上游收货单 不允许从 POSTED 变更为 DRAFT')
  })

  it('requires arbitration after supplier rejection', () => {
    assertUpstreamArrivalClaimTransition('PENDING_SUPPLIER', 'SUPPLIER_REJECTED')
    assertUpstreamArrivalClaimTransition('SUPPLIER_REJECTED', 'ARBITRATION')
    expect(() => assertUpstreamArrivalClaimTransition('SUPPLIER_REJECTED', 'RESOLVED')).toThrow()
  })

  it('locks a confirmed settlement before invoicing', () => {
    assertUpstreamSettlementTransition('CONFIRMED', 'LOCKED')
    assertUpstreamSettlementTransition('LOCKED', 'INVOICED')
    expect(() => assertUpstreamSettlementTransition('CONFIRMED', 'INVOICED')).toThrow()
  })
})
describe('upstream receipt review policy', () => {
  it('lets an ordinary receipt post with one confirmation', () => {
    expect(requiresUpstreamReceiptReview({
      payableAmount: 999,
      reviewAmountThreshold: 10_000,
      hasOverReceipt: false,
      hasTemporaryPrice: false,
      hasSensitiveCategory: false,
    })).toBe(false)
  })

  it('explains every matched second-review trigger', () => {
    expect(upstreamReceiptReviewReasons({
      payableAmount: 10_000,
      reviewAmountThreshold: 10_000,
      hasOverReceipt: true,
      hasTemporaryPrice: true,
      hasSensitiveCategory: true,
    })).toEqual([
      'AMOUNT_THRESHOLD',
      'OVER_RECEIPT',
      'TEMPORARY_PRICE',
      'SENSITIVE_CATEGORY',
    ])
  })

  it('enforces separation between inspector and reviewer', () => {
    expect(() => assertDifferentReceiptReviewer('same-user', 'same-user'))
      .toThrow('复核人必须与验收人不同')
    expect(() => assertDifferentReceiptReviewer('inspector', 'reviewer')).not.toThrow()
  })
})
