import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FORMAL_DELIVERY_STATUSES,
  SERVER_SHIPMENT_DRAFT_KEY,
  publicDeliveryMarkerFilter,
} from '../../src/services/shipmentDraftMarker'

describe('shipment draft rollback architecture boundary', () => {
  it('keeps the compatibility marker dependency-free and outside the feature implementation', () => {
    const source = readFileSync(new URL('../../src/services/shipmentDraftMarker.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(SERVER_SHIPMENT_DRAFT_KEY).toBe('server-shipment-draft-v1')
    expect(publicDeliveryMarkerFilter()).toEqual({
      OR: [
        { idempotencyKey: null },
        { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
      ],
    })
  })

  it('guards both cross-delivery totals against DRAFT rows', () => {
    const source = readFileSync(new URL('../../src/services/deliveryItemRemoval.ts', import.meta.url), 'utf8')
    const formalStatusUses = source.match(/status: formalDeliveryStatusFilter\(\)/g) || []
    expect(FORMAL_DELIVERY_STATUSES).toEqual(['SHIPPED', 'DELIVERED', 'RECEIVED'])
    expect(formalStatusUses).toHaveLength(2)
    expect(source).not.toContain("deliveryOrder: { purchaseOrderId: delivery.purchaseOrderId, status: { not: 'CANCELLED' } }")
  })
})
