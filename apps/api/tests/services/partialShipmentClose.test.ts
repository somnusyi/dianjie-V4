import { describe, expect, it } from 'vitest'
import {
  buildShipmentCloseSummary,
  reservationCloseState,
  shipmentReplayMatches,
  shipmentRequestFingerprint,
} from '../../src/services/partialShipmentClose'

describe('partial shipment closes unshipped remainder', () => {
  it('keeps ordered and shipped quantities distinct for a full shipment', () => {
    const summary = buildShipmentCloseSummary([
      { itemId: 'line-a', productId: 'product-a', orderedQty: 6, shippedQty: 6 },
    ])

    expect(summary).toEqual({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      remainderClosed: true,
      hasClosedRemainder: false,
      isPartial: false,
      lines: [{
        itemId: 'line-a',
        productId: 'product-a',
        productName: null,
        orderedQty: 6,
        shippedQty: 6,
        closedQty: 0,
      }],
    })
    expect(reservationCloseState(6, 6)).toMatchObject({
      status: 'CONSUMED',
      markConsumedAt: true,
      markReleasedAt: false,
    })
  })

  it('closes every unshipped line remainder and releases only that remainder', () => {
    const summary = buildShipmentCloseSummary([
      { itemId: 'line-a', productId: 'product-a', productName: '鲜菌', orderedQty: 6, shippedQty: 4 },
      { itemId: 'line-b', productId: 'product-b', productName: '生菜', orderedQty: 3, shippedQty: 0 },
    ])

    expect(summary).toMatchObject({
      remainderClosed: true,
      hasClosedRemainder: true,
      isPartial: true,
      lines: [
        { orderedQty: 6, shippedQty: 4, closedQty: 2 },
        { orderedQty: 3, shippedQty: 0, closedQty: 3 },
      ],
    })
    expect(reservationCloseState(6, 4)).toMatchObject({
      status: 'CONSUMED',
      markConsumedAt: true,
      markReleasedAt: true,
    })
    expect(Number(reservationCloseState(6, 4).fulfilledQty)).toBe(4)
    expect(Number(reservationCloseState(6, 4).releasedQty)).toBe(2)
    expect(reservationCloseState(3, 0)).toMatchObject({
      status: 'RELEASED',
      markConsumedAt: false,
      markReleasedAt: true,
    })
    expect(Number(reservationCloseState(3, 0).fulfilledQty)).toBe(0)
  })

  it('represents an all-zero shipment without conflating zero with removal', () => {
    const summary = buildShipmentCloseSummary([
      { itemId: 'line-a', productId: 'product-a', orderedQty: 6, shippedQty: 0 },
      { itemId: 'line-b', productId: 'product-b', orderedQty: 3, shippedQty: 0 },
    ])

    expect(summary).toMatchObject({
      hasClosedRemainder: true,
      isPartial: true,
      lines: [
        { itemId: 'line-a', shippedQty: 0, closedQty: 6 },
        { itemId: 'line-b', shippedQty: 0, closedQty: 3 },
      ],
    })
  })

  it('replays the same fingerprint and identifies a conflicting request', () => {
    const firstItems = [
      { itemId: 'line-b', shippedQty: 0 },
      { itemId: 'line-a', shippedQty: 4 },
    ]
    const sameItemsDifferentOrder = [...firstItems].reverse()
    const fingerprint = shipmentRequestFingerprint('部分发货', firstItems)
    expect(shipmentRequestFingerprint('部分发货', sameItemsDifferentOrder)).toBe(fingerprint)

    const candidate = {
      note: '部分发货',
      items: [
        { purchaseOrderItemId: 'line-a', shippedQty: 4 },
        { purchaseOrderItemId: 'line-b', shippedQty: 0 },
      ],
      events: [{ metadata: { requestFingerprint: fingerprint } as any }],
    }
    expect(shipmentReplayMatches(candidate, {
      note: '部分发货',
      items: firstItems,
      fingerprint,
    })).toBe(true)
    expect(shipmentReplayMatches(candidate, {
      note: '冲突请求',
      items: [{ itemId: 'line-a', shippedQty: 3 }],
      fingerprint: shipmentRequestFingerprint('冲突请求', [{ itemId: 'line-a', shippedQty: 3 }]),
    })).toBe(false)
  })
})
