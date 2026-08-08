import { describe, expect, it } from 'vitest'
import { productUpstreamSourcesBodySchema } from '../../src/routes/productUpstreamSources'

const validSource = {
  supplierId: 'supplier-1',
  isPrimary: true,
  supplierSku: 'SKU-001',
  purchaseUnit: '箱',
  inventoryUnitsPerPurchaseUnit: 12,
  quotedUnitPrice: 120,
  minOrderQty: 1,
  leadTimeDays: 2,
  note: '含税到仓',
}

describe('product upstream sources payload', () => {
  it('accepts an empty source list and one primary among multiple sources', () => {
    expect(productUpstreamSourcesBodySchema.safeParse({ sources: [] }).success).toBe(true)
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [
        validSource,
        { ...validSource, supplierId: 'supplier-2', isPrimary: false },
      ],
    }).success).toBe(true)
  })

  it('rejects duplicate suppliers and invalid primary selection', () => {
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [validSource, { ...validSource, isPrimary: false }],
    }).success).toBe(false)
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [{ ...validSource, isPrimary: false }],
    }).success).toBe(false)
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [validSource, { ...validSource, supplierId: 'supplier-2' }],
    }).success).toBe(false)
  })

  it('rejects non-positive conversions, quantities and out-of-range lead time', () => {
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [{ ...validSource, inventoryUnitsPerPurchaseUnit: 0 }],
    }).success).toBe(false)
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [{ ...validSource, minOrderQty: 0 }],
    }).success).toBe(false)
    expect(productUpstreamSourcesBodySchema.safeParse({
      sources: [{ ...validSource, leadTimeDays: 366 }],
    }).success).toBe(false)
  })
})
