import { describe, expect, it } from 'vitest'
import { isV2PathAllowedForRole, rolesForV2Path } from './v2-route-access'

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

  it('allows only the dedicated internal supply-chain workspace', () => {
    expect(rolesForV2Path('/v2/supply-chain/home')).toEqual(['SUPPLY_CHAIN'])
    expect(rolesForV2Path('/v2/supply-chain/products')).toEqual(['SUPPLY_CHAIN'])
    expect(rolesForV2Path('/v2/supply-chain/receipts')).toEqual(['SUPPLY_CHAIN'])
    expect(rolesForV2Path('/v2/supply-chain/orders')).toEqual(['SUPPLY_CHAIN'])
    expect(rolesForV2Path('/v2/supply-chain/deliveries')).toEqual(['SUPPLY_CHAIN'])
    expect(rolesForV2Path('/v2/supply-chain/stores')).toEqual(['SUPPLY_CHAIN'])
    expect(isV2PathAllowedForRole('/v2/supply-chain/home', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/supply-chain/products', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/supply-chain/receipts', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/supply-chain/orders', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/supply-chain/deliveries', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/supply-chain/stores', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/me', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/me/password', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/feedback/new', 'SUPPLY_CHAIN')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/feedback/mine', 'SUPPLY_CHAIN')).toBe(true)
  })

  it('rejects supplier, finance, sales, identity and write paths for internal supply-chain', () => {
    for (const path of [
      '/v2/supplier/home',
      '/v2/supplier/orders/po-1',
      '/v2/supplier/inventory/inbound',
      '/v2/supplier/billing',
      '/v2/supplier/analytics',
      '/v2/supplier/products',
      '/v2/finance/home',
      '/v2/manager/revenue',
      '/v2/inventory-counts',
      '/v2/me/team',
      '/v2/me/suppliers',
    ]) {
      expect(isV2PathAllowedForRole(path, 'SUPPLY_CHAIN')).toBe(false)
    }
  })

  it('does not narrow existing roles outside the internal workspace', () => {
    expect(isV2PathAllowedForRole('/v2/supplier/home', 'SUPPLIER_OWNER')).toBe(true)
    expect(isV2PathAllowedForRole('/v2/manager/home', 'MANAGER')).toBe(true)
  })

  it('leaves shared and separately guarded pages unchanged', () => {
    expect(rolesForV2Path('/v2/login')).toBeUndefined()
    expect(rolesForV2Path('/v2/inventory-counts')).toBeUndefined()
    expect(rolesForV2Path('/v2/finance-pc/home')).toBeUndefined()
  })
})
