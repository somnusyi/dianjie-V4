/**
 * Stable compatibility marker for internal shipment drafts.
 *
 * Keep this outside the shipment-draft implementation so the delivery-list
 * compatibility release can retain the marker filter even when the feature
 * implementation itself is rolled back.
 */
export const SERVER_SHIPMENT_DRAFT_KEY = 'server-shipment-draft-v1'

export const FORMAL_DELIVERY_STATUSES = ['SHIPPED', 'DELIVERED', 'RECEIVED'] as const

export function formalDeliveryStatusFilter() {
  return { in: [...FORMAL_DELIVERY_STATUSES] }
}

/** Prisma `not` does not include SQL NULL, so both public cases are explicit. */
export function publicDeliveryMarkerFilter() {
  return {
    OR: [
      { idempotencyKey: null },
      { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
    ],
  }
}
