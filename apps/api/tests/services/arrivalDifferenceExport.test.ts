import { describe, expect, it } from 'vitest'
import { arrivalDifferencesToCsv } from '../../src/services/arrivalDifferenceExport'

describe('arrival difference CSV export', () => {
  it('exports frozen product wording and neutralizes formulas', () => {
    const csv = arrivalDifferencesToCsv([{
      no: 'LC1', createdAt: new Date('2026-07-17T01:02:03Z'), kind: 'ARRIVAL_SHORTAGE',
      status: 'PENDING', payableBasis: 'NET_AT_RECEIPT', totalLossAmount: 12,
      description: '+异常说明', store: { name: '=危险门店' },
      purchaseOrder: { no: 'PO1' }, deliveryOrder: { no: 'DO1' }, receipt: { no: 'RK1' },
      items: [{
        productNameSnapshot: '冻结商品名', productUnitSnapshot: '斤', lossQty: 1, lossAmount: 12,
        product: { name: '已改商品名', unit: '箱' },
      }],
    }])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv).toContain("'=危险门店")
    expect(csv).toContain("'+异常说明")
    expect(csv).toContain('冻结商品名 1斤')
    expect(csv).not.toContain('已改商品名')
  })
})
