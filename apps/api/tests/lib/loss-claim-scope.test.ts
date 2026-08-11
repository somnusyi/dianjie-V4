import { describe, expect, it } from 'vitest'
import { lossClaimScope } from '../../src/lib/loss-claim-scope'
import { canHandleArrivalDifference } from '../../src/routes/lossClaims'

describe('lossClaimScope', () => {
  it('集团角色只限定租户', () => {
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'CHEF_DIRECTOR' })).toEqual({
      tenantId: 'tenant-a',
    })
  })

  it('内部供应链可处理本租户到货差异，门店和财务角色不可代替供应链确认', () => {
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'SUPPLY_CHAIN' })).toEqual({
      tenantId: 'tenant-a',
    })
    expect(canHandleArrivalDifference('SUPPLY_CHAIN')).toBe(true)
    expect(canHandleArrivalDifference('SUPPLIER_OWNER')).toBe(true)
    expect(canHandleArrivalDifference('ADMIN')).toBe(true)
    expect(canHandleArrivalDifference('KITCHEN_LEAD')).toBe(false)
    expect(canHandleArrivalDifference('FINANCE')).toBe(false)
  })

  it('门店角色限定租户和门店', () => {
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'KITCHEN_LEAD', storeId: 'store-a' })).toEqual({
      tenantId: 'tenant-a',
      storeId: 'store-a',
    })
  })

  it('供应商角色限定租户和供应商', () => {
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'SUPPLIER_OWNER', supplierId: 'supplier-a' })).toEqual({
      tenantId: 'tenant-a',
      supplierId: 'supplier-a',
    })
  })

  it('未绑定范围的角色不会意外获得全租户数据', () => {
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'MANAGER' })).toMatchObject({ storeId: '__NONE__' })
    expect(lossClaimScope({ tenantId: 'tenant-a', role: 'SUPPLIER_STAFF' })).toMatchObject({ supplierId: '__NONE__' })
  })
})
