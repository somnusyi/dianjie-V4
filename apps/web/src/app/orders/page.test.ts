import { describe, expect, it } from 'vitest'
import { legacyOrdersDestination } from './legacy-orders-redirect'

describe('legacy orders compatibility redirect', () => {
  it('routes every operational role to its current workflow instead of the obsolete write screen', () => {
    for (const role of ['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB']) {
      expect(legacyOrdersDestination(role)).toBe('/v2/supplier/orders')
    }
    expect(legacyOrdersDestination('KITCHEN_LEAD')).toBe('/v2/chef/purchase')
    for (const role of ['CHEF', 'CHEF_DIRECTOR']) {
      expect(legacyOrdersDestination(role)).toBe('/v2/chef-director/orders')
    }
    for (const role of ['MANAGER', 'SUPERVISOR', 'PURCHASER', 'REGIONAL_MANAGER']) {
      expect(legacyOrdersDestination(role)).toBe('/v2/manager/home')
    }
    for (const role of ['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN']) {
      expect(legacyOrdersDestination(role)).toBe('/v2/supply-chain/fulfillment')
    }
    expect(legacyOrdersDestination('FINANCE')).toBe('/v2/finance/home')
    expect(legacyOrdersDestination('ENGINEERING')).toBe('/v2/engineer/home')
    expect(legacyOrdersDestination(undefined)).toBe('/v2/login')
  })
})
