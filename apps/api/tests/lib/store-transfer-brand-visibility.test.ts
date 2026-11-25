import { describe, expect, it } from 'vitest'
import { transferMatchesCurrentBrand, visibleStoreTransferBrand } from '../../src/lib/store-transfer-brand-visibility'

describe('store transfer brand visibility', () => {
  it('derives one confirmed brand from a store-side account', () => {
    expect(visibleStoreTransferBrand([{ brandCode: 'DIANJIE' }, { brandCode: 'DIANJIE' }])).toBe('DIANJIE')
    expect(visibleStoreTransferBrand([{ brandCode: 'DIANJIE' }, { brandCode: 'LANCANGYAO' }])).toBeNull()
    expect(visibleStoreTransferBrand([{ brandCode: null }])).toBeNull()
  })

  it('hides historical transfers without a brand snapshot', () => {
    expect(transferMatchesCurrentBrand({ brandCode: null, fromStore: { brandCode: 'DIANJIE' }, toStore: { brandCode: 'DIANJIE' } }, 'DIANJIE')).toBe(false)
  })

  it('hides a transfer when either store changed to another brand', () => {
    expect(transferMatchesCurrentBrand({ brandCode: 'DIANJIE', fromStore: { brandCode: 'DIANJIE' }, toStore: { brandCode: 'LANCANGYAO' } }, 'DIANJIE')).toBe(false)
    expect(transferMatchesCurrentBrand({ brandCode: 'DIANJIE', fromStore: { brandCode: 'LANCANGYAO' }, toStore: { brandCode: 'DIANJIE' } }, 'DIANJIE')).toBe(false)
  })

  it('shows a same-brand transfer', () => {
    expect(transferMatchesCurrentBrand({ brandCode: 'DIANJIE', fromStore: { brandCode: 'DIANJIE' }, toStore: { brandCode: 'DIANJIE' } }, 'DIANJIE')).toBe(true)
  })
})
