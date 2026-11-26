import { describe, expect, it } from 'vitest'
import { canCreateTransfer, canViewTransfer, sameConfirmedBrand } from '../../src/lib/store-transfer-access'

describe('store transfer access', () => {
  it('allows the store manager to initiate only from an assigned store', () => {
    const manager = { role: 'MANAGER', storeId: 'a', storeIds: ['a'] }
    expect(canCreateTransfer(manager, 'a')).toBe(true)
    expect(canCreateTransfer(manager, 'b')).toBe(false)
    expect(canCreateTransfer({ role: 'SUPPLY_CHAIN' }, 'a')).toBe(false)
  })

  it('limits store-side visibility to participating stores', () => {
    const manager = { role: 'MANAGER', storeId: 'a' }
    expect(canViewTransfer(manager, { fromStoreId: 'a', toStoreId: 'b' })).toBe(true)
    expect(canViewTransfer(manager, { fromStoreId: 'b', toStoreId: 'c' })).toBe(false)
    expect(canViewTransfer({ role: 'SUPPLY_CHAIN' }, { fromStoreId: 'b', toStoreId: 'c' })).toBe(true)
  })

  it('rejects unconfirmed or different brands', () => {
    expect(sameConfirmedBrand({ brandCode: 'DIANJIE' }, { brandCode: 'DIANJIE' })).toBe(true)
    expect(sameConfirmedBrand({ brandCode: 'DIANJIE' }, { brandCode: 'LANCANGYAO' })).toBe(false)
    expect(sameConfirmedBrand({ brandCode: null }, { brandCode: null })).toBe(false)
  })
})
