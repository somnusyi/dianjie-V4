import { describe, expect, it } from 'vitest'
import { isStoreScoped, isSupplierRole, requireStoreBinding, requireSupplierBinding } from '../../src/lib/auth-scope'

describe('auth scope helpers', () => {
  it('recognizes store and supplier roles', () => {
    expect(isStoreScoped('KITCHEN_LEAD')).toBe(true)
    expect(isStoreScoped('ADMIN')).toBe(false)
    expect(isSupplierRole('SUPPLIER_OWNER')).toBe(true)
    expect(isSupplierRole('MANAGER')).toBe(false)
  })

  it('fails closed when a store account is not bound', () => {
    expect(requireStoreBinding('MANAGER', 'store-a')).toBe('store-a')
    expect(requireStoreBinding('ADMIN', undefined)).toBeUndefined()
    expect(() => requireStoreBinding('KITCHEN_LEAD', undefined)).toThrow()
    expect(() => requireStoreBinding('PURCHASER', null)).toThrow()
  })

  it('returns the supplier binding for supplier accounts', () => {
    expect(requireSupplierBinding('SUPPLIER_OWNER', 'supplier-a')).toBe('supplier-a')
    expect(requireSupplierBinding('SUPPLIER_STAFF', 'supplier-b')).toBe('supplier-b')
  })

  it('fails closed when a supplier account is not bound', () => {
    expect(() => requireSupplierBinding('SUPPLIER_OWNER', null)).toThrow()
    expect(() => requireSupplierBinding('SUPPLIER_STAFF', undefined)).toThrow()
  })

  it('does not require a supplier binding for non-supplier roles', () => {
    expect(requireSupplierBinding('ADMIN', null)).toBeUndefined()
  })
})
