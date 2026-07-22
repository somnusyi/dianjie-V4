import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import {
  aggregateByProduct, dailyQtyByProduct, groupDetailRows, summarizeMonth, trailingAvgQty,
  type ConsumptionSourceRow,
} from '../../src/services/storeConsumption'
import { voidConsumptionWithCorrection } from '../../src/services/consumptionCorrection'

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

  it('correction rows (sourceType=correction) are normal rows for aggregation', () => {
    // 作废行的剔除发生在查询层 (voidedAt: null); 聚合函数把传入的补记行当普通行计入
    const rows = [
      row({ productId: 'p1', dishId: 'd1', sourceType: 'correction', inventoryQuantity: D('0.018333'), costAmountSnapshot: D('0.6967') }),
      row({ productId: 'p1', dishId: 'd1', inventoryQuantity: D('1'), costAmountSnapshot: D('2') }),
    ]
    const agg = aggregateByProduct(rows).get('p1')!
    expect(agg.qty.toFixed(6)).toBe('1.018333')
    expect(agg.cost.toFixed(4)).toBe('2.6967')
    const groups = groupDetailRows(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0].dishId).toBe('d1')
  })
})

// ── 冲销/补记 service (stubbed tx) ─────────────────────────
describe('voidConsumptionWithCorrection', () => {
  const originalRow = {
    id: 'row-1', tenantId: 't1', storeId: 's1', productId: 'p1',
    date: utcDate('2026-07-18'),
    quantity: D('18.333333'), inventoryQuantity: D('54999.999'),
    unitSnapshot: '桶', inventoryUnitSnapshot: 'g',
    unitCostSnapshot: D('0.012667'), costAmountSnapshot: D('696.6667'),
    note: '每日销量×BOM；轻颜羽衣甘蓝 1份', dishId: 'd1', variantKey: '', bomVersionId: 'bom-1',
    voidedAt: null,
  }

  function stubTx(row: typeof originalRow | null) {
    const calls = { update: [] as any[], create: [] as any[] }
    const tx = {
      stockConsumption: {
        findFirst: async () => row,
        update: async (args: any) => { calls.update.push(args); return { ...row, ...args.data } },
        create: async (args: any) => { calls.create.push(args); return { id: 'correction-1', ...args.data } },
      },
    }
    return { tx: tx as any, calls }
  }

  it('voids the original row and inserts a correction row with scaled values', async () => {
    const { tx, calls } = stubTx(originalRow)
    const result = await voidConsumptionWithCorrection(tx, {
      consumptionId: 'row-1', tenantId: 't1', reason: '单位换算 bug', voidedById: 'admin-1',
      correctedQuantity: D('0.018333'), correctedInventoryQuantity: D('55'),
    })
    expect(result).toEqual({ voidedId: 'row-1', correctionId: 'correction-1' })

    const update = calls.update[0]
    expect(update.where).toEqual({ id: 'row-1' })
    expect(update.data.voidedAt).toBeInstanceOf(Date)
    expect(update.data.voidedReason).toBe('单位换算 bug')
    expect(update.data.voidedById).toBe('admin-1')

    const data = calls.create[0].data
    expect(data).toMatchObject({
      tenantId: 't1', storeId: 's1', productId: 'p1', dishId: 'd1', bomVersionId: 'bom-1',
      sourceType: 'correction', sourceId: 'row-1', sourceLineKey: 'correction',
      correctionOfId: 'row-1', createdById: 'admin-1',
      unitSnapshot: '桶', inventoryUnitSnapshot: 'g',
    })
    expect(data.quantity.toFixed(6)).toBe('0.018333')
    expect(data.inventoryQuantity.toFixed(6)).toBe('55.000000')
    // 未显式传修正金额时按 修正库存量 × 原 unitCostSnapshot 计算
    expect(data.costAmountSnapshot.toFixed(4)).toBe('0.6967')
    expect(data.calculationSnapshot).toMatchObject({
      correctionOf: 'row-1', originalInventoryQuantity: '54999.999', reason: '单位换算 bug',
    })
  })

  it('voids without correction when no corrected values are given', async () => {
    const { tx, calls } = stubTx(originalRow)
    const result = await voidConsumptionWithCorrection(tx, {
      consumptionId: 'row-1', tenantId: 't1', reason: 'BOM 配方错误，待确认', voidedById: 'admin-1',
    })
    expect(result).toEqual({ voidedId: 'row-1', correctionId: null })
    expect(calls.update).toHaveLength(1)
    expect(calls.create).toHaveLength(0)
  })

  it('rejects a second void with 409 (idempotent error)', async () => {
    const { tx } = stubTx({ ...originalRow, voidedAt: new Date() })
    await expect(voidConsumptionWithCorrection(tx, {
      consumptionId: 'row-1', tenantId: 't1', reason: '重复冲销', voidedById: 'admin-1',
    })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('returns 404 when the row does not exist in the tenant', async () => {
    const { tx } = stubTx(null)
    await expect(voidConsumptionWithCorrection(tx, {
      consumptionId: 'missing', tenantId: 't1', reason: 'x', voidedById: 'admin-1',
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects negative corrected values with 400', async () => {
    const { tx } = stubTx(originalRow)
    await expect(voidConsumptionWithCorrection(tx, {
      consumptionId: 'row-1', tenantId: 't1', reason: 'x', voidedById: 'admin-1',
      correctedInventoryQuantity: D('-1'),
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
