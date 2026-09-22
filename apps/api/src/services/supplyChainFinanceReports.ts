import { Prisma } from '@dianjie/db'
import { z } from 'zod'
import { businessDateKey, businessDateRangeInclusive } from '../lib/businessTime'
import { reportQuerySchema } from './inventoryReports'

export const financeReportIds = ['group-profit', 'item-profit', 'profit-detail'] as const
export type FinanceReportId = typeof financeReportIds[number]
export type FinanceRow = Record<string, string | number | null>
type Column = { key: string; label: string; kind?: 'money' | 'quantity' | 'percent' }
const c = (key: string, label: string, kind?: Column['kind']): Column => ({ key, label, ...(kind ? { kind } : {}) })
export const financeDefinitions = {
  'group-profit': { title: '集团毛利分析表', columns: [c('customer', '客户名称'), c('center', '配送中心'), c('profit', '折后毛利', 'money'), c('revenue', '折后收入', 'money'), c('cost', '出库成本', 'money')] },
  'item-profit': { title: '集团物品毛利分析表', columns: [c('warehouse', '仓库'), c('customer', '客户名称'), c('category', '类别名称'), c('itemName', '物品名称'), c('spec', '规格'), c('unit', '单位'), c('quantity', '净销量', 'quantity'), c('revenue', '折后收入', 'money'), c('cost', '出库成本', 'money'), c('rate', '毛利率', 'percent'), c('averageRevenue', '折后收入均价', 'money'), c('averageCost', '出库成本均价', 'money')] },
  'profit-detail': { title: '集团毛利明细表', columns: [c('code', '编码'), c('name', '名称'), c('itemCode', '物品编码'), c('spec', '规格型号'), c('document', '单据号'), c('date', '业务日期'), c('source', '出入库相关项'), c('quantity', '数量', 'quantity'), c('cost', '成本', 'money'), c('revenue', '发货金额', 'money')] },
} satisfies Record<FinanceReportId, { title: string; columns: Column[] }>
const text = z.string().trim().max(120).default('')
export const financeQuerySchema = z.object({ customer: text, center: text, keyword: text, warehouse: text, category: text, unit: text, document: text, source: text }).passthrough().transform((raw, ctx) => {
  const parsed = reportQuerySchema.safeParse(raw)
  if (!parsed.success) { for (const issue of parsed.error.issues) ctx.addIssue(issue); return z.NEVER }
  return { ...parsed.data, customer: raw.customer, center: raw.center, document: raw.document, source: raw.source }
})
export type FinanceQuery = z.infer<typeof financeQuerySchema>
const dec = (v: any) => new Prisma.Decimal(v ?? 0)
const limit = 20000
function bounded<T>(rows: T[]): T[] {
  if (rows.length > limit) throw Object.assign(new Error('记录超过 20,000 条，请缩小日期范围后查询'), { statusCode: 422 })
  return rows
}
const reversalSources = ['ReceiptRejectionReversal', 'LossClaimReversal', 'DeliveryOrderShipCancel']
const note = '总部配送毛利口径：收入按配送行冻结成交单价×业务数量，成本按出库台账金额；退回/短缺/撤销在发生日冲减。数量为库存单位，配送中心按出库仓库。缺少成本或金额依据时显示“—”，相关汇总毛利不计算。此为配送经营报表，不含门店营业额、采购退货、门店调拨或未关联配送的美团导入。'

export function aggregateFinance(rows: FinanceRow[], id: FinanceReportId): FinanceRow[] {
  if (id === 'profit-detail') return rows
  const groups = new Map<string, FinanceRow>()
  for (const row of rows) {
    const key = JSON.stringify(id === 'group-profit' ? [row.customerId, row.warehouseId] : [row.customerId, row.warehouseId, row.productId, row.unit, row.spec, row.category])
    const g = groups.get(key) || { ...row, id: key, quantity: 0, revenue: 0, cost: 0 }
    for (const field of ['quantity', 'revenue', 'cost']) g[field] = g[field] == null || row[field] == null ? null : Number(dec(g[field]).plus(row[field]!))
    groups.set(key, g)
  }
  return [...groups.values()].map(g => {
    const profit = g.revenue == null || g.cost == null ? null : Number(dec(g.revenue).minus(g.cost))
    return { ...g, profit, rate: !g.revenue || profit == null ? null : Number(dec(profit).div(g.revenue)), averageRevenue: !g.quantity || g.revenue == null ? null : Number(dec(g.revenue).div(g.quantity)), averageCost: !g.quantity || g.cost == null ? null : Number(dec(g.cost).div(g.quantity)) }
  })
}

/** Read-only projection; original and reversal facts are retained even after delivery cancellation. */
export async function loadFinanceReport(tx: Prisma.TransactionClient, tenantId: string, id: FinanceReportId, q: FinanceQuery) {
  const range = businessDateRangeInclusive(q.start, q.end)
  const period = { gte: range.start, lt: range.endExclusive }
  const movements = bounded(await tx.warehouseLedgerMovement.findMany({ where: { tenantId, effectiveAt: period, OR: [{ type: 'ORDER_OUTBOUND', sourceType: 'DeliveryOrder' }, { type: 'REVERSAL', sourceType: { in: reversalSources } }] }, include: { warehouse: true }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }], take: limit + 1 }))
  // Reversals can reference an original outside the selected period.
  const originals = bounded(await tx.warehouseLedgerMovement.findMany({ where: { tenantId, type: 'ORDER_OUTBOUND', sourceType: 'DeliveryOrder', id: { in: movements.filter(m => m.type === 'REVERSAL').map(m => m.sourceLineId) } }, take: limit + 1 }))
  const byOriginal = new Map(originals.map(m => [m.id, m]))
  const deliveryIds = [...new Set([...movements.filter(m => m.type === 'ORDER_OUTBOUND').map(m => m.sourceId), ...originals.map(m => m.sourceId)])]
  const deliveries = bounded(await tx.deliveryOrder.findMany({ where: { tenantId, supplier: { tenantId, sourceType: 'HEADQ_WAREHOUSE' }, store: { tenantId }, OR: [{ id: { in: deliveryIds } }, { shippedAt: period, status: { in: ['SHIPPED', 'DELIVERED', 'RECEIVED'] } }] }, include: { store: true, warehouse: true, items: { include: { product: true } } }, take: limit + 1 }))
  const byDelivery = new Map(deliveries.map(d => [d.id, d]))
  const historical = bounded(await tx.warehouseLedgerMovement.findMany({ where: { tenantId, type: 'ORDER_OUTBOUND', sourceType: 'DeliveryOrder', sourceId: { in: deliveries.map(d => d.id) } }, select: { sourceId: true, productId: true }, take: limit + 1 }))
  const ledgerLines = new Set(historical.map(m => `${m.sourceId}/${m.productId}`))
  const rows: FinanceRow[] = []
  let unmatched = 0
  function base(d: typeof deliveries[number], item: typeof deliveries[number]['items'][number], warehouseId: string | null, warehouseName: string | null): FinanceRow {
    return { customerId: d.storeId, customer: d.store.name, code: d.store.no, name: d.store.name, warehouseId, warehouse: warehouseName, center: warehouseName, productId: item.productId, itemCode: item.productCodeSnapshot, itemName: item.productNameSnapshot, spec: item.productSpecSnapshot, category: item.productCategorySnapshot, document: d.no }
  }
  for (const m of movements) {
    const original = m.type === 'REVERSAL' ? byOriginal.get(m.sourceLineId) : m
    const d = original && byDelivery.get(original.sourceId)
    const item = d?.items.find(i => i.productId === m.productId && i.product.tenantId === tenantId && (!original?.sourceLineId || i.purchaseOrderItemId === original.sourceLineId))
    if (!original || !d || !item || original.warehouseId !== m.warehouseId || original.productId !== m.productId) { unmatched++; continue }
    const sign = m.type === 'REVERSAL' ? -1 : 1
    rows.push({ ...base(d, item, m.warehouseId, m.warehouse.name), id: m.id, date: businessDateKey(m.effectiveAt), source: m.sourceType === 'ReceiptRejectionReversal' ? '返货入库' : m.sourceType === 'LossClaimReversal' ? '到货短缺冲回' : m.sourceType === 'DeliveryOrderShipCancel' ? '配送撤销/减量' : '配送出库', unit: m.inventoryUnit, quantity: Number(m.physicalDelta.negated()), cost: Number(m.valueDelta.negated()), revenue: Number(m.originalQuantity.mul(item.unitPriceSnapshot).mul(sign).toDecimalPlaces(2)) })
  }
  // OFF / historical shipments have real sales but no frozen warehouse cost. Never invent zero cost.
  for (const d of deliveries) {
    if (!d.shippedAt || d.shippedAt < range.start || d.shippedAt >= range.endExclusive || !['SHIPPED', 'DELIVERED', 'RECEIVED'].includes(d.status)) continue
    for (const item of d.items) {
      if (item.product.tenantId !== tenantId || item.removedAt || item.shippedQty.lte(0) || ledgerLines.has(`${d.id}/${item.productId}`)) continue
      const factor = item.inventoryUnitsPerOrderUnitSnapshot
      rows.push({ ...base(d, item, d.warehouseId, d.warehouse?.name ?? null), id: `unposted:${item.id}`, date: businessDateKey(d.shippedAt), source: '配送出库（未记成本）', unit: item.inventoryUnitSnapshot, quantity: factor?.gt(0) ? Number(item.shippedQty.mul(factor)) : null, revenue: Number(item.amount), cost: null })
    }
  }
  bounded(rows)
  const options = Object.fromEntries(['customer', 'center', 'warehouse', 'category', 'unit', 'source'].map(k => [k, [...new Set(rows.flatMap(r => r[k] == null ? [] : [String(r[k])]))].sort((a, b) => a.localeCompare(b, 'zh-CN'))]))
  const filtered = rows.filter(r => {
    for (const key of ['customer', 'center', 'warehouse', 'category', 'unit', 'source'] as const) if (q[key] && r[key] !== q[key]) return false
    if (q.document && !String(r.document).includes(q.document)) return false
    return !q.keyword || `${r.itemName ?? ''} ${r.itemCode ?? ''} ${r.name ?? ''} ${r.code ?? ''}`.toLowerCase().includes(q.keyword.toLowerCase())
  })
  let result = aggregateFinance(filtered, id).filter(r => Object.entries(q.ranges).every(([key, v]) => r[key] != null && typeof r[key] === 'number' && (v.min == null || Number(r[key]) >= v.min) && (v.max == null || Number(r[key]) <= v.max)))
  const sort = financeDefinitions[id].columns.some(c => c.key === q.sort) ? q.sort : id === 'profit-detail' ? 'date' : 'customer'
  result.sort((a, b) => { const av = a[sort], bv = b[sort]; if (av == null) return bv == null ? 0 : 1; if (bv == null) return -1; return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })) * (q.direction === 'desc' ? -1 : 1) || String(a.id).localeCompare(String(b.id)) })
  const total = result.length, page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)))
  const warnings = []
  if (filtered.some(r => r.cost == null)) warnings.push('部分配送尚无成本台账，成本及相关毛利显示“—”；未记成本行按配送单当前实发金额展示。')
  if (unmatched) warnings.push(`${unmatched} 条流水缺少可核对的配送关联，未计入报表，请核对原单。`)
  return { ...financeDefinitions[id], id, note, warnings, options, rows: q.export === '1' ? result : result.slice((page - 1) * q.pageSize, page * q.pageSize), total, page, pageSize: q.pageSize, generatedAt: new Date().toISOString() }
}
