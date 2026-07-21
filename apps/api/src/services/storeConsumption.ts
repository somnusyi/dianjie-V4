/**
 * 门店食材消耗聚合 (stock_consumptions 只读口径)
 *
 * 数据源: 日报 BOM 扣减 (sourceType=dish_sale / meituan_ingest, 带 dishId)
 *        + 门店人工消耗/报损 (sourceType=manual)
 * 口径: 数量取 inventoryQuantity (库存基础单位), 历史空值回退 quantity;
 *       金额取 costAmountSnapshot, 空值按 0 处理。
 * 所有累计都用 Prisma.Decimal, 输出层才转 number。
 */
import { Prisma } from '@dianjie/db'

export type ConsumptionSourceRow = {
  productId: string
  dishId: string | null
  sourceType: string | null
  date: Date
  quantity: Prisma.Decimal | number | string
  inventoryQuantity: Prisma.Decimal | number | string | null
  costAmountSnapshot: Prisma.Decimal | number | string | null
}

export type ProductAggregate = {
  productId: string
  qty: Prisma.Decimal
  cost: Prisma.Decimal
  dishCount: number
}

export function qtyOf(row: Pick<ConsumptionSourceRow, 'quantity' | 'inventoryQuantity'>): Prisma.Decimal {
  return new Prisma.Decimal(row.inventoryQuantity ?? row.quantity ?? 0)
}

export function costOf(row: Pick<ConsumptionSourceRow, 'costAmountSnapshot'>): Prisma.Decimal {
  return new Prisma.Decimal(row.costAmountSnapshot ?? 0)
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** 按食材聚合一段行集: qty / cost / 去重菜品数 */
export function aggregateByProduct(rows: ConsumptionSourceRow[]): Map<string, ProductAggregate> {
  const map = new Map<string, ProductAggregate & { dishIds: Set<string> }>()
  for (const row of rows) {
    let agg = map.get(row.productId)
    if (!agg) {
      agg = { productId: row.productId, qty: new Prisma.Decimal(0), cost: new Prisma.Decimal(0), dishCount: 0, dishIds: new Set() }
      map.set(row.productId, agg)
    }
    agg.qty = agg.qty.plus(qtyOf(row))
    agg.cost = agg.cost.plus(costOf(row))
    if (row.dishId) agg.dishIds.add(row.dishId)
  }
  const out = new Map<string, ProductAggregate>()
  for (const [productId, agg] of map) {
    out.set(productId, { productId, qty: agg.qty, cost: agg.cost, dishCount: agg.dishIds.size })
  }
  return out
}

/** 按 食材×自然日 汇总数量, 供"前 7 个有数据自然日均值"计算 */
export function dailyQtyByProduct(rows: ConsumptionSourceRow[]): Map<string, Map<string, Prisma.Decimal>> {
  const map = new Map<string, Map<string, Prisma.Decimal>>()
  for (const row of rows) {
    let byDate = map.get(row.productId)
    if (!byDate) {
      byDate = new Map()
      map.set(row.productId, byDate)
    }
    const key = dateKey(row.date)
    byDate.set(key, (byDate.get(key) ?? new Prisma.Decimal(0)).plus(qtyOf(row)))
  }
  return map
}

/**
 * 前 N 个有数据自然日 (严格早于 targetDate) 的日均消耗量。
 * 无历史数据时返回 null, 由调用方决定如何展示。
 */
export function trailingAvgQty(
  dailyTotals: Map<string, Prisma.Decimal> | undefined,
  targetDate: string,
  days = 7,
): Prisma.Decimal | null {
  if (!dailyTotals) return null
  const dates = [...dailyTotals.keys()].filter(d => d < targetDate).sort().reverse().slice(0, days)
  if (dates.length === 0) return null
  const total = dates.reduce((sum, d) => sum.plus(dailyTotals.get(d)!), new Prisma.Decimal(0))
  return total.div(dates.length)
}

export type MonthSummary = {
  totalCost: Prisma.Decimal
  daysWithData: number
  byProduct: Map<string, { qty: Prisma.Decimal; cost: Prisma.Decimal }>
}

/** 月度合计: 总金额 / 有数据天数 / 分食材小计 */
export function summarizeMonth(rows: ConsumptionSourceRow[]): MonthSummary {
  const dates = new Set<string>()
  let totalCost = new Prisma.Decimal(0)
  const byProduct = new Map<string, { qty: Prisma.Decimal; cost: Prisma.Decimal }>()
  for (const row of rows) {
    dates.add(dateKey(row.date))
    const cost = costOf(row)
    totalCost = totalCost.plus(cost)
    let agg = byProduct.get(row.productId)
    if (!agg) {
      agg = { qty: new Prisma.Decimal(0), cost: new Prisma.Decimal(0) }
      byProduct.set(row.productId, agg)
    }
    agg.qty = agg.qty.plus(qtyOf(row))
    agg.cost = agg.cost.plus(cost)
  }
  return { totalCost, daysWithData: dates.size, byProduct }
}

export type ConsumptionDetailGroup = {
  key: string
  dishId: string | null
  manual: boolean
  qty: Prisma.Decimal
  cost: Prisma.Decimal
}

/**
 * 单食材当日明细: BOM 行按 dishId 聚合; sourceType=manual (人工消耗/报损)
 * 单独聚成一组标注; 其余无菜品来源按 sourceType 归组兜底。
 */
export function groupDetailRows(rows: ConsumptionSourceRow[]): ConsumptionDetailGroup[] {
  const map = new Map<string, ConsumptionDetailGroup>()
  for (const row of rows) {
    const manual = row.sourceType === 'manual'
    const key = manual ? 'manual' : row.dishId ? `dish:${row.dishId}` : `source:${row.sourceType || 'other'}`
    let group = map.get(key)
    if (!group) {
      group = { key, dishId: manual ? null : row.dishId, manual, qty: new Prisma.Decimal(0), cost: new Prisma.Decimal(0) }
      map.set(key, group)
    }
    group.qty = group.qty.plus(qtyOf(row))
    group.cost = group.cost.plus(costOf(row))
  }
  return [...map.values()]
}
