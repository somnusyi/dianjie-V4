import { describe, expect, it } from 'vitest'
import { aggregateFinance, financeQuerySchema } from '../src/services/supplyChainFinanceReports'
const row = (extra: any = {}) => ({ id: '1', customerId: 'c', warehouseId: 'w', productId: 'p', unit: 'kg', spec: '', category: '', quantity: 3, revenue: 0.3, cost: 0.1, ...extra })
describe('financial aggregate edge cases', () => {
  it('uses decimal addition and weighted totals instead of adding rates', () => {
    const result = aggregateFinance([row(), row({ quantity: 1, revenue: 0.1, cost: 0.2 })], 'item-profit')[0]
    expect(result).toMatchObject({ quantity: 4, revenue: 0.4, cost: 0.3, profit: 0.1, rate: 0.25, averageRevenue: 0.1, averageCost: 0.075 })
  })
  it('keeps unknown costs unknown and avoids zero denominators on complete returns', () => {
    expect(aggregateFinance([row(), row({ quantity: -3, revenue: -0.3, cost: -0.1 })], 'item-profit')[0]).toMatchObject({ quantity: 0, revenue: 0, cost: 0, rate: null, averageRevenue: null, averageCost: null })
    expect(aggregateFinance([row(), row({ cost: null })], 'group-profit')[0]).toMatchObject({ revenue: 0.6, cost: null, profit: null })
  })
  it('never merges different customers, warehouses or inventory units', () => {
    expect(aggregateFinance([row(), row({ customerId: 'c2' }), row({ warehouseId: 'w2' }), row({ unit: '箱' })], 'item-profit')).toHaveLength(4)
  })
  it('validates calendar dates and finite numeric ranges', () => {
    for (const invalid of [{ start: '2026-02-30' }, { start: '2026-10-01', end: '2026-09-01' }, { ranges: '{"cost":{"min":1e999}}' }]) expect(financeQuerySchema.safeParse(invalid).success).toBe(false)
  })
})
