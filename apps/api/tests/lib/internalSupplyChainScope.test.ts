import { describe, expect, it } from 'vitest'
import { isStoreScoped, isSupplierRole } from '../../src/lib/auth-scope'
import {
  allowsSupplyDataRead,
  hasInternalSupplyChainCapability,
  INTERNAL_SUPPLY_CHAIN_READ_CAPABILITIES,
  isInternalSupplyChainRole,
  supplyDataReadScope,
  type InternalSupplyChainCapability,
} from '../../src/lib/internal-supply-chain-access'

describe('internal supply-chain scope', () => {
  it('is neither store-scoped nor supplier-bound', () => {
    expect(isStoreScoped('SUPPLY_CHAIN')).toBe(false)
    expect(isSupplierRole('SUPPLY_CHAIN')).toBe(false)
  })

  it('builds a tenant-only cross-store read filter', () => {
    expect(supplyDataReadScope({
      tenantId: 'tenant-a',
      role: 'SUPPLY_CHAIN',
      storeId: 'stale-store-binding',
      supplierId: 'stale-supplier-binding',
    })).toEqual({ tenantId: 'tenant-a' })
  })

  it('keeps external suppliers bound to their supplierId', () => {
    expect(supplyDataReadScope({
      tenantId: 'tenant-a',
      role: 'SUPPLIER_OWNER',
      supplierId: 'supplier-a',
    })).toEqual({
      tenantId: 'tenant-a',
      supplierId: 'supplier-a',
    })
  })

  it('fails closed when a store or external supplier binding is absent', () => {
    expect(supplyDataReadScope({
      tenantId: 'tenant-a',
      role: 'MANAGER',
      storeId: null,
    })).toEqual({ tenantId: 'tenant-a', storeId: '__NONE__' })

    expect(() => supplyDataReadScope({
      tenantId: 'tenant-a',
      role: 'SUPPLIER_OWNER',
      supplierId: null,
    })).toThrow()
  })

  it('never accepts a caller-supplied tenant override', () => {
    const scope = supplyDataReadScope({
      tenantId: 'tenant-a',
      role: 'SUPPLY_CHAIN',
      storeId: 'store-in-tenant-b',
      supplierId: 'supplier-in-tenant-b',
    })
    expect(scope).toEqual({ tenantId: 'tenant-a' })
    expect(scope).not.toHaveProperty('tenantId', 'tenant-b')
  })

  it('grants only the five explicit read capabilities', () => {
    for (const capability of INTERNAL_SUPPLY_CHAIN_READ_CAPABILITIES) {
      expect(hasInternalSupplyChainCapability('SUPPLY_CHAIN', capability)).toBe(true)
      expect(allowsSupplyDataRead('SUPPLY_CHAIN', capability)).toBe(true)
    }

    const forbiddenWrites: InternalSupplyChainCapability[] = [
      'order.write',
      'delivery.write',
      'receipt.write',
      'inventory.write',
      'consumption.write',
      'product.approve',
      'product.write',
      'finance.write',
      'store.write',
    ]
    for (const capability of forbiddenWrites) {
      expect(hasInternalSupplyChainCapability('SUPPLY_CHAIN', capability)).toBe(false)
    }
  })

  it('is an explicit role rather than an alias of a privileged role', () => {
    expect(isInternalSupplyChainRole('SUPPLY_CHAIN')).toBe(true)
    for (const privilegedRole of ['MANAGER', 'CHEF_DIRECTOR', 'ADMIN', 'FINANCE']) {
      expect(isInternalSupplyChainRole(privilegedRole)).toBe(false)
    }
  })
})
