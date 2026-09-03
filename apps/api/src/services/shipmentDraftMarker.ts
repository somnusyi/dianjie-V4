/**
 * Stable compatibility boundary for server-side shipment drafts.
 *
 * This module deliberately has no dependency on the shipment-draft feature.
 * Legacy read paths import it so they keep hiding internal drafts even if the
 * feature implementation is rolled back while draft rows remain in storage.
 */
export const SERVER_SHIPMENT_DRAFT_KEY = 'server-shipment-draft-v1'

export const FORMAL_DELIVERY_STATUSES = ['SHIPPED', 'DELIVERED', 'RECEIVED'] as const

/** Prisma-compatible predicate that excludes rows owned by the draft feature. */
export function legacyVisibleDeliveryWhere() {
  return {
    OR: [
      { idempotencyKey: null },
      { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
    ],
  }
}
