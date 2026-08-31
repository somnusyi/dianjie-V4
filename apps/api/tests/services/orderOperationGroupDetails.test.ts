import { describe, expect, it } from 'vitest'
import { mergeOperationGroupItems } from '../../src/services/orderOperationGroupDetails'

describe('operation group printable item merge', () => {
  it('merges only identical product snapshots and preserves source order numbers', () => {
    const items = mergeOperationGroupItems([
      {
        no: 'PO-01',
        items: [
          { productId: 'p1', name: '土豆', spec: '10kg', unit: '箱', quantity: '2', amount: '20.00' },
          { productId: 'p2', name: '青菜', spec: null, unit: '把', quantity: '3', amount: '9.00' },
        ],
      },
      {
        no: 'PO-02',
        items: [
          { productId: 'p1', name: '土豆', spec: '10kg', unit: '箱', quantity: '1', amount: '11.00' },
          // Same SKU but a different frozen specification is a separate line.
          { productId: 'p1', name: '土豆', spec: '5kg', unit: '箱', quantity: '1', amount: '6.00' },
        ],
      },
    ])

    expect(items).toHaveLength(3)
    expect(items.find(item => item.spec === '10kg')).toMatchObject({
      productId: 'p1', quantity: '3.00', amount: '31.00', sourceOrderNos: ['PO-01', 'PO-02'],
    })
    expect(items.find(item => item.spec === '5kg')).toMatchObject({
      productId: 'p1', quantity: '1.00', amount: '6.00', sourceOrderNos: ['PO-02'],
    })
  })
})
