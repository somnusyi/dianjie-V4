import { describe, expect, it } from 'vitest'
import { routeFor } from '../../src/services/documentRouting'

describe('supplier offer document routing', () => {
  it.each(['SUPPLIER_OFFER_CREATE', 'SUPPLIER_OFFER_DISABLE'] as const)(
    'routes %s directly to the chef director',
    type => {
      expect(routeFor(type, 0)).toMatchObject({
        steps: ['CHEF_DIRECTOR'],
        autoApprove: false,
        isOverThreshold: false,
      })
    },
  )
})
