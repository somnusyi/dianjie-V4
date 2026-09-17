import { describe, expect, it } from 'vitest'
import { isUpstreamOnlySupplier, supplierPortalMode } from './supplier-experience'

describe('supplier portal experience', () => {
  it('separates warehouse-upstream suppliers from store fulfillers', () => {
    expect(supplierPortalMode(['WAREHOUSE_UPSTREAM'])).toBe('UPSTREAM_ONLY')
    expect(isUpstreamOnlySupplier(['WAREHOUSE_UPSTREAM'])).toBe(true)
    expect(supplierPortalMode(['STORE_FULFILLER'])).toBe('STORE_ONLY')
    expect(supplierPortalMode(['DIRECT_STORE_VENDOR'])).toBe('STORE_ONLY')
  })

  it('keeps dual-scope and legacy sessions explicit', () => {
    expect(supplierPortalMode(['WAREHOUSE_UPSTREAM', 'STORE_FULFILLER'])).toBe('MIXED')
    expect(supplierPortalMode(undefined)).toBe('UNKNOWN')
    expect(supplierPortalMode([])).toBe('UNKNOWN')
  })
})
