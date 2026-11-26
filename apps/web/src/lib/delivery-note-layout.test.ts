import { describe, expect, it } from 'vitest'
import { sortDeliveryNoteItems } from './delivery-note-layout'

describe('delivery category ordering', () => {
  it('keeps chicken out of mushroom products, follows maintained category order, and leaves source money intact', () => {
    const rows = [
      { id: 'm2', amount: '22.20', product: { name: '龙爪菇', category: '菌菇', unit: 'kg', spec: null, code: 'M2' } },
      { id: 'c', amount: '9.99', product: { name: '鸡架', category: '禽类', unit: '件', spec: null, code: 'C' } },
      { id: 'm1', amount: '11.10', product: { name: '金耳菌', category: '菌菇', unit: 'kg', spec: null, code: 'M1' } },
    ]
    const sorted = sortDeliveryNoteItems(rows, ['菌菇', '禽类'])
    expect(sorted.map(row => row.id)).toEqual(['m1', 'm2', 'c'])
    expect(rows.map(row => row.id)).toEqual(['m2', 'c', 'm1'])
    expect(sorted.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(43.29)
    expect(sorted[0]).toBe(rows[2])
  })
  it('sorts within each category by natural pick location, placing unset locations last', () => {
    const product=(name:string,category:string,location:string|null)=>({name,category,location,spec:null,unit:'kg',code:name})
    const rows=[{product:product('香菇','菌菇','冷藏-10'),amount:'10.01'},{product:product('鸡架','禽类','冷冻-1'),amount:'20.02'},{product:product('松茸','菌菇',null),amount:'30.03'},{product:product('竹荪','菌菇','冷藏-2'),amount:'40.04'}]
    expect(sortDeliveryNoteItems(rows,['菌菇','禽类']).map(row=>row.product.name)).toEqual(['竹荪','香菇','松茸','鸡架'])
    expect(rows.map(row=>row.amount)).toEqual(['10.01','20.02','30.03','40.04'])
  })

})
