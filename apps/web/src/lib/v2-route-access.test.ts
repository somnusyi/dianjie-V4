import { describe, expect, it } from 'vitest'
import { rolesForV2Path } from './v2-route-access'

describe('rolesForV2Path', () => {
  it('protects every manager page from supplier sessions', () => {
    expect(rolesForV2Path('/v2/manager/home')).toEqual(['MANAGER', 'PURCHASER'])
    expect(rolesForV2Path('/v2/manager/inventory')).toEqual(['MANAGER', 'PURCHASER'])
  })

  it('protects every supplier page from store sessions', () => {
    expect(rolesForV2Path('/v2/supplier/home')).toEqual([
      'SUPPLIER_OWNER',
      'SUPPLIER_STAFF',
      'SUPPLIER_SUB',
    ])
    expect(rolesForV2Path('/v2/supplier/inventory/inbound')).toEqual([
      'SUPPLIER_OWNER',
      'SUPPLIER_STAFF',
      'SUPPLIER_SUB',
    ])
  })

  it('leaves shared and separately guarded pages unchanged', () => {
    expect(rolesForV2Path('/v2/login')).toBeUndefined()
    expect(rolesForV2Path('/v2/inventory-counts')).toBeUndefined()
    expect(rolesForV2Path('/v2/finance-pc/home')).toBeUndefined()
  })
})
