import { describe, expect, it } from 'vitest'
import { isSupersedableInternalPendingRevisionEvent, revisionCreateSchema } from '../../src/routes/orders'

describe('operation-group direct revision request contract', () => {
  const base = {
    operationGroupId: 'og_0123456789abcdef01234567',
    reason: '接单时直接调整',
    baseRowVersion: 0,
    requestKey: 'direct-revision-request',
  }

  it('accepts catalog and custom products in one non-empty desired item list', () => {
    const parsed = revisionCreateSchema.safeParse({
      ...base,
      items: [
        { productId: 'product-1', quantity: 2 },
        {
          customProduct: { name: '临时菌菇', spec: '', unit: '件', unitPrice: 12.34 },
          quantity: 1.5,
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects an empty order and custom prices or quantities beyond persisted precision', () => {
    expect(revisionCreateSchema.safeParse({ ...base, items: [] }).success).toBe(false)
    expect(revisionCreateSchema.safeParse({
      ...base,
      items: [{ customProduct: { name: '临时菌菇', unit: '件', unitPrice: 12.345 }, quantity: 1 }],
    }).success).toBe(false)
    expect(revisionCreateSchema.safeParse({
      ...base,
      items: [{ customProduct: { name: '临时菌菇', unit: '件', unitPrice: 12.34 }, quantity: 1.234 }],
    }).success).toBe(false)
  })

  it('keeps the legacy catalog-only revision shape valid', () => {
    expect(revisionCreateSchema.safeParse({
      reason: '供应商调整数量', baseRowVersion: 0,
      requestKey: 'legacy-revision-request',
      items: [{ productId: 'product-1', quantity: 2.345 }],
    }).success).toBe(true)
  })
})

describe('pending revision provenance', () => {
  it('uses immutable request-event role and metadata, never the requester current role', () => {
    expect(isSupersedableInternalPendingRevisionEvent({
      actorRole: 'SUPPLY_CHAIN',
      metadata: { revisionId: 'revision-1', operationGroupId: null },
    })).toBe(true)
    expect(isSupersedableInternalPendingRevisionEvent({
      actorRole: 'SUPPLIER_OWNER',
      metadata: { revisionId: 'revision-1', directApplied: true, source: 'SINGLE_ORDER_DIRECT_REVISION' },
    })).toBe(false)
  })

  it('fails closed when legacy event metadata is absent or the operation group differs', () => {
    expect(isSupersedableInternalPendingRevisionEvent({ actorRole: 'SUPPLY_CHAIN', metadata: null })).toBe(false)
    expect(isSupersedableInternalPendingRevisionEvent({
      actorRole: 'SUPPLY_CHAIN',
      metadata: { revisionId: 'revision-1', operationGroupId: 'og_aaaaaaaaaaaaaaaaaaaaaaaa' },
    }, 'og_bbbbbbbbbbbbbbbbbbbbbbbb')).toBe(false)
  })
})
