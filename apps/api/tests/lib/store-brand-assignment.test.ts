import { describe, expect, it } from 'vitest'
import { isValidStoreBrandAssignment } from '../../src/lib/store-brand-assignment'

const dianjie = { brandCode: 'DIANJIE' }
const lancangyao = { brandCode: 'LANCANGYAO' }
const legacy = { brandCode: null }

describe('store-side brand assignment ceiling', () => {
  it.each(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'PURCHASER', 'SUPERVISOR', 'REGIONAL_MANAGER', 'STAFF'])(
    '%s cannot combine stores from different brands', role => {
      expect(isValidStoreBrandAssignment(role, [dianjie, lancangyao])).toBe(false)
      expect(isValidStoreBrandAssignment(role, [dianjie, dianjie])).toBe(true)
    },
  )

  it('keeps unconfirmed legacy stores separate from confirmed brands', () => {
    expect(isValidStoreBrandAssignment('MANAGER', [legacy, dianjie])).toBe(false)
    expect(isValidStoreBrandAssignment('MANAGER', [legacy, legacy])).toBe(true)
  })

  it.each(['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN', 'FINANCE', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF'])(
    '%s remains group-wide or supplier-scoped', role => {
      expect(isValidStoreBrandAssignment(role, [dianjie, lancangyao])).toBe(true)
    },
  )
})
