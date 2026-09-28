import { describe, expect, it } from 'vitest'
import {
  assertReplenishmentTransition,
  canTransitionReplenishment,
  deriveReplenishmentFulfillmentStatus,
  replenishmentNextAction,
} from '../../src/services/replenishmentOrderPolicy'

describe('replenishment state policy', () => {
  it('allows only the reviewed forward workflow and pre-fulfillment cancellation', () => {
    expect(canTransitionReplenishment('DRAFT', 'SUBMITTED')).toBe(true)
    expect(canTransitionReplenishment('SUBMITTED', 'ACCEPTED')).toBe(true)
    expect(canTransitionReplenishment('DRAFT', 'CANCELLED')).toBe(true)
    expect(canTransitionReplenishment('SUBMITTED', 'CANCELLED')).toBe(true)
    expect(canTransitionReplenishment('ACCEPTED', 'CANCELLED')).toBe(false)
    expect(() => assertReplenishmentTransition('ACCEPTED', 'CANCELLED')).toThrow('补货单不能从 ACCEPTED 变更为 CANCELLED')
  })

  it('derives progress from the linked formal order without treating one delivery as completion', () => {
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: true, linkedOrderStatus: 'CONFIRMED' })).toBe('ACCEPTED')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: true, linkedOrderStatus: 'DELIVERING' })).toBe('FULFILLING')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: true, linkedOrderStatus: 'RECEIVED' })).toBe('FULFILLING')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: true, linkedOrderStatus: 'COMPLETED' })).toBe('COMPLETED')
  })

  it('exposes broken or cancelled fulfillment links as exceptions', () => {
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: false, linkedOrderStatus: null })).toBe('EXCEPTION')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'ACCEPTED', hasFulfillmentLink: true, linkedOrderStatus: 'CANCELLED' })).toBe('EXCEPTION')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'DRAFT', hasFulfillmentLink: true, linkedOrderStatus: 'CONFIRMED' })).toBe('EXCEPTION')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'SUBMITTED', hasFulfillmentLink: true, linkedOrderStatus: 'CONFIRMED' })).toBe('EXCEPTION')
    expect(deriveReplenishmentFulfillmentStatus({ storedStatus: 'CANCELLED', hasFulfillmentLink: true, linkedOrderStatus: 'CANCELLED' })).toBe('EXCEPTION')
  })

  it('returns exactly one primary next action for every page state', () => {
    expect(replenishmentNextAction('DRAFT')).toEqual({ label: '继续编辑', action: 'EDIT' })
    expect(replenishmentNextAction('SUBMITTED')).toEqual({ label: '接单', action: 'ACCEPT' })
    expect(replenishmentNextAction('ACCEPTED')).toEqual({ label: '查看订单', action: 'VIEW_ORDER' })
    expect(replenishmentNextAction('FULFILLING')).toEqual({ label: '查看配送', action: 'VIEW_FULFILLMENT' })
    expect(replenishmentNextAction('COMPLETED')).toEqual({ label: '查看收货', action: 'VIEW_RECEIPT' })
    expect(replenishmentNextAction('EXCEPTION')).toEqual({ label: '处理异常', action: 'RESOLVE_EXCEPTION' })
    expect(replenishmentNextAction('CANCELLED')).toEqual({ label: '查看记录', action: 'VIEW' })
  })
})
