import { describe, expect, it } from 'vitest'
import {
  requireSupplierCapability,
  supplierCapabilitiesForRole,
  SUPPLIER_CAPABILITIES,
} from '../../src/lib/supplier-access'

describe('supplier capability architecture', () => {
  it('keeps owner and staff on the same capability set for the current phase', () => {
    expect([...supplierCapabilitiesForRole('SUPPLIER_OWNER')]).toEqual(SUPPLIER_CAPABILITIES)
    expect([...supplierCapabilitiesForRole('SUPPLIER_STAFF')]).toEqual(SUPPLIER_CAPABILITIES)
  })

  it('fails closed for unbound or non-supplier accounts', () => {
    expect(() => requireSupplierCapability('SUPPLIER_STAFF', null, 'inventory.read')).toThrow()
    expect(() => requireSupplierCapability('MANAGER', 'supplier-a', 'inventory.read')).toThrow()
  })

  it('returns only the authenticated supplier binding', () => {
    expect(requireSupplierCapability('SUPPLIER_OWNER', 'supplier-a', 'order.ship')).toBe('supplier-a')
  })
})
