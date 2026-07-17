import { describe, expect, it } from 'vitest'
import { productCatalogCacheScope } from '../../src/routes/products'

describe('product catalog cache scope', () => {
  it('isolates supplier, store-approved and governance catalog caches', () => {
    const supplier = productCatalogCacheScope('SUPPLIER_OWNER', 'supplier-a')
    const store = productCatalogCacheScope('KITCHEN_LEAD')
    const governance = productCatalogCacheScope('CHEF_DIRECTOR')
    expect(new Set([supplier, store, governance]).size).toBe(3)
    expect(supplier).toBe('supplier:supplier-a')
    expect(store).toBe('store:approved')
    expect(governance).toBe('governance:all')
  })

  it('keeps different suppliers in different caches', () => {
    expect(productCatalogCacheScope('SUPPLIER_STAFF', 'supplier-a'))
      .not.toBe(productCatalogCacheScope('SUPPLIER_STAFF', 'supplier-b'))
  })
})
