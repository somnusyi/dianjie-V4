import { describe, expect, it } from 'vitest'
import { isStoreScoped, isSupplierRole, requireSupplierBinding, resolveActiveStore, storeScopeOf } from '../../src/lib/auth-scope'

describe('auth scope helpers', () => {
  it('recognizes store and supplier roles', () => {
    expect(isStoreScoped('KITCHEN_LEAD')).toBe(true)
    expect(isStoreScoped('ADMIN')).toBe(false)
    expect(isStoreScoped('REGIONAL_MANAGER')).toBe(true)
    expect(isStoreScoped('SUPERVISOR')).toBe(true)
    expect(isSupplierRole('SUPPLIER_OWNER')).toBe(true)
    expect(isSupplierRole('MANAGER')).toBe(false)
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

describe('multi-store scope (方案 C 第一阶段)', () => {
  it('returns null scope for tenant-level roles', () => {
    expect(storeScopeOf({ role: 'ADMIN', storeId: 's1', storeIds: ['s1'] })).toBeNull()
    expect(storeScopeOf({ role: 'FINANCE' })).toBeNull()
    expect(storeScopeOf({ role: undefined })).toBeNull()
  })

  it('uses storeIds array when present', () => {
    expect(storeScopeOf({ role: 'MANAGER', storeId: 's1', storeIds: ['s1', 's2'] })).toEqual(['s1', 's2'])
  })

  it('falls back to single storeId for legacy tokens without storeIds', () => {
    expect(storeScopeOf({ role: 'MANAGER', storeId: 's1' })).toEqual(['s1'])
    expect(storeScopeOf({ role: 'MANAGER', storeId: 's1', storeIds: [] })).toEqual(['s1'])
  })

  it('returns empty array (fail-closed) for store roles with no binding', () => {
    expect(storeScopeOf({ role: 'MANAGER' })).toEqual([])
    expect(storeScopeOf({ role: 'KITCHEN_LEAD', storeId: null, storeIds: null })).toEqual([])
  })

  it('dedupes overlapping storeIds', () => {
    expect(storeScopeOf({ role: 'MANAGER', storeIds: ['s1', 's1', 's2'] })).toEqual(['s1', 's2'])
  })

  it('resolveActiveStore passes through requested store for tenant-level roles', () => {
    expect(resolveActiveStore({ role: 'ADMIN' }, 's9')).toBe('s9')
    expect(resolveActiveStore({ role: 'ADMIN' }, null)).toBeUndefined()
  })

  it('resolveActiveStore accepts any store within the scope set', () => {
    const user = { role: 'MANAGER', storeId: 's1', storeIds: ['s1', 's2'] }
    expect(resolveActiveStore(user, 's2')).toBe('s2')
    expect(resolveActiveStore(user, 's1')).toBe('s1')
  })

  it('resolveActiveStore defaults to the first store in scope', () => {
    expect(resolveActiveStore({ role: 'MANAGER', storeIds: ['s1', 's2'] }, null)).toBe('s1')
    expect(resolveActiveStore({ role: 'MANAGER', storeId: 's1' })).toBe('s1')
  })

  it('resolveActiveStore throws 403 for out-of-scope stores', () => {
    const user = { role: 'MANAGER', storeId: 's1', storeIds: ['s1', 's2'] }
    expect(() => resolveActiveStore(user, 's3')).toThrow()
    try {
      resolveActiveStore(user, 's3')
    } catch (e: any) {
      expect(e.statusCode).toBe(403)
    }
  })

  it('resolveActiveStore returns undefined for unbound store roles (caller fail-closed)', () => {
    expect(resolveActiveStore({ role: 'REGIONAL_MANAGER' }, null)).toBeUndefined()
  })
})
