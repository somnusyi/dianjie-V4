import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import {
  aggregateByProduct, dailyQtyByProduct, groupDetailRows, summarizeMonth, trailingAvgQty,
  type ConsumptionSourceRow,
} from '../../src/services/storeConsumption'

const D = (value: number | string) => new Prisma.Decimal(value)
const utcDate = (day: string) => new Date(`${day}T00:00:00.000Z`)

function row(partial: Partial<ConsumptionSourceRow> & { productId: string }): ConsumptionSourceRow {
  return {
    dishId: null, sourceType: 'dish_sale', date: utcDate('2026-07-10'),
    quantity: D(1), inventoryQuantity: D(1), costAmountSnapshot: D(1),
    ...partial,
  }
}

describe('storeConsumption aggregation', () => {
  it('aggregateByProduct sums with Decimal and counts distinct dishes', () => {
    const rows = [
      row({ productId: 'p1', dishId: 'd1', inventoryQuantity: D('1.5'), costAmountSnapshot: D('10.005') }),
      row({ productId: 'p1', dishId: 'd1', inventoryQuantity: D('0.25'), costAmountSnapshot: D('2.5') }),
      row({ productId: 'p1', dishId: 'd2', inventoryQuantity: D('0.25'), costAmountSnapshot: null }),
      row({ productId: 'p2', dishId: null, sourceType: 'manual', inventoryQuantity: D('3'), costAmountSnapshot: D('7.5') }),
    ]
    const result = aggregateByProduct(rows)
    const p1 = result.get('p1')!
    expect(p1.qty.toFixed(6)).toBe('2.000000')
    expect(p1.cost.toFixed(4)).toBe('12.5050')
    expect(p1.dishCount).toBe(2)
    const p2 = result.get('p2')!
    expect(p2.dishCount).toBe(0)
    expect(p2.cost.toFixed(2)).toBe('7.50')
  })

  it('aggregateByProduct falls back to quantity when inventoryQuantity is null', () => {
    const rows = [row({ productId: 'p1', inventoryQuantity: null, quantity: D('4.5') })]
    expect(aggregateByProduct(rows).get('p1')!.qty.toFixed(1)).toBe('4.5')
  })

  it('trailingAvgQty averages the last N days with data before the target date', () => {
    const daily = dailyQtyByProduct([
      row({ productId: 'p1', date: utcDate('2026-07-09'), inventoryQuantity: D('10') }),
      row({ productId: 'p1', date: utcDate('2026-07-08'), inventoryQuantity: D('4') }),
      row({ productId: 'p1', date: utcDate('2026-07-08'), inventoryQuantity: D('2') }),
      // 目标日当天不参与均值
      row({ productId: 'p1', date: utcDate('2026-07-10'), inventoryQuantity: D('99') }),
    ])
    const avg = trailingAvgQty(daily.get('p1'), '2026-07-10')
    // (10 + 6) / 2 = 8
    expect(avg!.toFixed(4)).toBe('8.0000')
  })

  it('trailingAvgQty skips gaps and caps at 7 most recent data days', () => {
    const rows: ConsumptionSourceRow[] = []
    for (let i = 1; i <= 10; i += 1) {
      // 7/01..7/09 中挑 9 天 + 6 月一天, 每天量=1
      const day = i <= 9 ? `2026-07-0${i}` : '2026-06-15'
      rows.push(row({ productId: 'p1', date: utcDate(day), inventoryQuantity: D('1') }))
    }
    const daily = dailyQtyByProduct(rows)
    const avg = trailingAvgQty(daily.get('p1'), '2026-07-10')
    expect(avg!.toFixed(2)).toBe('1.00')
    expect(trailingAvgQty(daily.get('missing'), '2026-07-10')).toBeNull()
    expect(trailingAvgQty(undefined, '2026-07-10')).toBeNull()
  })

  it('groupDetailRows groups BOM rows by dish and isolates manual rows', () => {
    const groups = groupDetailRows([
      row({ productId: 'p1', dishId: 'd1', inventoryQuantity: D('1'), costAmountSnapshot: D('5') }),
      row({ productId: 'p1', dishId: 'd1', inventoryQuantity: D('2'), costAmountSnapshot: D('10') }),
      row({ productId: 'p1', dishId: 'd2', inventoryQuantity: D('1'), costAmountSnapshot: D('5') }),
      row({ productId: 'p1', dishId: null, sourceType: 'manual', inventoryQuantity: D('0.5'), costAmountSnapshot: D('2.5') }),
      row({ productId: 'p1', dishId: null, sourceType: 'manual', inventoryQuantity: D('0.5'), costAmountSnapshot: D('2.5') }),
    ])
    expect(groups).toHaveLength(3)
    const manual = groups.find(g => g.manual)!
    expect(manual.qty.toFixed(1)).toBe('1.0')
    expect(manual.cost.toFixed(1)).toBe('5.0')
    const d1 = groups.find(g => g.dishId === 'd1')!
    expect(d1.qty.toFixed(1)).toBe('3.0')
    expect(d1.cost.toFixed(1)).toBe('15.0')
  })

  it('summarizeMonth totals cost, counts data days and per-product sums', () => {
    const summary = summarizeMonth([
      row({ productId: 'p1', date: utcDate('2026-07-01'), costAmountSnapshot: D('10') }),
      row({ productId: 'p2', date: utcDate('2026-07-01'), costAmountSnapshot: D('20') }),
      row({ productId: 'p1', date: utcDate('2026-07-03'), costAmountSnapshot: D('5.555') }),
    ])
    expect(summary.totalCost.toFixed(3)).toBe('35.555')
    expect(summary.daysWithData).toBe(2)
    expect(summary.byProduct.get('p1')!.cost.toFixed(3)).toBe('15.555')
  })
})
