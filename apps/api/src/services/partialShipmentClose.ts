import { Prisma } from '@dianjie/db'
import { hashRequestBody } from '../lib/idempotency'

export const SHIPMENT_CLOSE_POLICY = 'CLOSE_UNSHIPPED_REMAINDER' as const

type DecimalValue = number | string | Prisma.Decimal

export type ShipmentCloseLineInput = {
  itemId: string
  productId: string
  productName?: string | null
  orderedQty: DecimalValue
  shippedQty: DecimalValue
}

export type ShipmentCloseLine = {
  itemId: string
  productId: string
  productName: string | null
  orderedQty: number
  shippedQty: number
  closedQty: number
}

export type ShipmentCloseSummary = {
  policy: typeof SHIPMENT_CLOSE_POLICY
  remainderClosed: true
  hasClosedRemainder: boolean
  isPartial: boolean
  lines: ShipmentCloseLine[]
}

function quantity(value: DecimalValue) {
  return new Prisma.Decimal(value)
}

export function buildShipmentCloseSummary(lines: ShipmentCloseLineInput[]): ShipmentCloseSummary {
  const summarized = lines.map(line => {
    const orderedQty = quantity(line.orderedQty)
    const shippedQty = quantity(line.shippedQty)
    const closedQty = Prisma.Decimal.max(orderedQty.minus(shippedQty), 0)
    return {
      itemId: line.itemId,
      productId: line.productId,
      productName: line.productName || null,
      orderedQty: Number(orderedQty),
      shippedQty: Number(shippedQty),
      closedQty: Number(closedQty),
    }
  })
  const hasClosedRemainder = summarized.some(line => line.closedQty > 0)
  return {
    policy: SHIPMENT_CLOSE_POLICY,
    remainderClosed: true,
    hasClosedRemainder,
    isPartial: hasClosedRemainder,
    lines: summarized,
  }
}

export function shipmentRequestFingerprint(
  note: string | undefined,
  items: Array<{ itemId: string; shippedQty: number }> | undefined,
) {
  const normalizedItems = items
    ? [...new Map(items.map(item => [item.itemId, item.shippedQty])).entries()]
      .map(([itemId, shippedQty]) => ({ itemId, shippedQty }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId))
    : null
  return hashRequestBody({ note: note || null, items: normalizedItems }, 'supplier-shipment')
}

export function shipmentReplayMatches(
  candidate: {
    note: string | null
    items: Array<{
      purchaseOrderItemId: string | null
      shippedQty: DecimalValue
      orderedQtySnapshot?: DecimalValue
    }>
    events: Array<{ metadata: Prisma.JsonValue }>
  },
  request: {
    note: string | undefined
    items: Array<{ itemId: string; shippedQty: number }> | undefined
    fingerprint: string
  },
) {
  const storedFingerprint = (candidate.events[0]?.metadata as Record<string, unknown> | null)?.requestFingerprint
  if (typeof storedFingerprint === 'string') return storedFingerprint === request.fingerprint

  const legacyItemQty = new Map(candidate.items.map(item => [
    item.purchaseOrderItemId,
    Number(item.shippedQty),
  ]))
  return (candidate.note || null) === (request.note || null)
    && (
      request.items
        ? request.items.every(item =>
          Math.abs((legacyItemQty.get(item.itemId) ?? Number.NaN) - item.shippedQty) < 0.0001
        )
        : candidate.items.every(item =>
          item.orderedQtySnapshot !== undefined
          && quantity(item.shippedQty).equals(quantity(item.orderedQtySnapshot))
        )
    )
}

export function reservationCloseState(reservedQty: DecimalValue, shippedQty: DecimalValue) {
  const reserved = quantity(reservedQty)
  const shipped = quantity(shippedQty)
  const releasedQty = Prisma.Decimal.max(reserved.minus(shipped), 0)
  const consumed = shipped.greaterThan(0)
  return {
    status: consumed ? 'CONSUMED' as const : 'RELEASED' as const,
    fulfilledQty: shipped,
    releasedQty,
    markConsumedAt: consumed,
    markReleasedAt: releasedQty.greaterThan(0),
  }
}
