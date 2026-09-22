import { Prisma } from '@dianjie/db'
import { businessDateKey, businessDateRangeInclusive } from '../lib/businessTime'
import type { ReportQuery, ReportRow } from './inventoryReports'
const LIMIT = 20000
const decimal = (n: any) => new Prisma.Decimal(n ?? 0)
export function reportTimestamp(date: Date | null | undefined) {
  return date ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : null
}
const bounds = <T>(rows: T[]) => {
  if (rows.length > LIMIT) throw Object.assign(new Error('记录超过 20,000 条，请缩小仓库或物品范围'), { statusCode: 422 })
  return rows
}
const base = (p: any, w: any, unit: string): ReportRow => ({ productId: p.id, code: p.code, name: p.name, spec: p.spec, category: p.category, unit, baseUnit: unit, org: '总部', orgCode: null, warehouse: w.name, warehouseId: w.id })
const labels: Record<string, string> = { MANUAL_INBOUND: '手工入库', ORDER_OUTBOUND: '出库', ADJUSTMENT: '库存调整', LOSS: '报损', REVERSAL: '冲销' }
const otherSources = ['WarehouseManualInbound', 'WarehouseBatchManualInbound', 'WarehouseManualOutbound', 'WarehousePhysicalCount', 'WarehouseManualInboundReversal', 'WarehouseDocValueAdjust', 'LossClaimReversal']

export function daysWithoutOutbound(now: Date, lastOutbound?: Date | null, firstInbound?: Date | null) {
  const reference = lastOutbound || firstInbound
  if (!reference) return null
  return Math.max(0, Math.floor((Date.parse(businessDateKey(now)) - Date.parse(businessDateKey(reference))) / 86400000))
}
export function warehouseAlert(quantity: Prisma.Decimal, product: any) {
  const verified = product.unitConversionStatus === 'VERIFIED' && product.inventoryUnitsPerOrderUnit?.gt(0)
  const lower = verified ? decimal(product.minStock).mul(product.inventoryUnitsPerOrderUnit) : null
  return { minQty: lower == null ? null : Number(lower), maxQty: null, alertStatus: quantity.lte(0) ? '缺货' : lower == null ? '下限单位待确认' : quantity.lt(lower) ? '低于下限' : '未触发下限（未设上限）' }
}
export async function loadInventorySupplement(tx: Prisma.TransactionClient, tenantId: string, id: string, q: ReportQuery, scope: { tenantId: string; warehouseId?: string; product: Prisma.ProductWhereInput }): Promise<ReportRow[]> {
  if (id === 'other-summary') {
    const period = businessDateRangeInclusive(q.start, q.end)
    const movements = bounds(await tx.warehouseLedgerMovement.findMany({ where: { ...scope, effectiveAt: { gte: period.start, lt: period.endExclusive }, type: { notIn: ['ORDER_RESERVED', 'ORDER_RELEASED'] }, OR: [{ sourceType: { in: otherSources } }, { type: 'LOSS' }] }, include: { product: true, warehouse: true, docLines: { where: { tenantId }, include: { doc: true } } }, orderBy: { id: 'asc' }, take: LIMIT + 1 }))
    const grouped = new Map<string, ReportRow>()
    for (const m of movements) {
      const type = labels[m.type] || m.type
      if (q.type && type !== q.type) continue
      const reason = m.docLines[0]?.doc.reason || labels[m.type] || m.type
      const key = JSON.stringify([m.productId, m.warehouseId, m.inventoryUnit, type, reason])
      const g = grouped.get(key) || { ...base(m.product, m.warehouse, m.inventoryUnit), id: key, type, reason, quantity: 0, amount: 0 }
      g.quantity = Number(decimal(g.quantity).plus(m.physicalDelta)); g.amount = Number(decimal(g.amount).plus(m.valueDelta)); grouped.set(key, g)
    }
    return [...grouped.values()]
  }
  const balances = bounds(await tx.warehouseLedgerBalance.findMany({ where: { ...scope, ...(id === 'stagnant' ? { physicalQty: { gt: 0 } } : {}) }, include: { product: true, warehouse: true }, orderBy: { id: 'asc' }, take: LIMIT + 1 }))
  if (id === 'alerts') return balances.map(b => ({ ...base(b.product, b.warehouse, b.inventoryUnit), qty: Number(b.physicalQty), ...warehouseAlert(b.physicalQty, b.product) }))
  const now = new Date()
  const history = bounds(await tx.warehouseLedgerMovement.findMany({ where: { ...scope, productId: { in: balances.map(b => b.productId) }, effectiveAt: { lte: now }, physicalDelta: { not: 0 }, type: { notIn: ['ORDER_RESERVED', 'ORDER_RELEASED'] } }, select: { id: true, productId: true, warehouseId: true, inventoryUnit: true, effectiveAt: true, physicalDelta: true }, orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }], take: LIMIT + 1 }))
  type Movement = typeof history[number]
  const byKey = new Map<string, { firstIn?: Movement; lastIn?: Movement; lastOut?: Movement }>()
  const key = (m: { productId: string; warehouseId: string; inventoryUnit: string }) => `${m.warehouseId}/${m.productId}/${m.inventoryUnit}`
  for (const m of history) {
    const group = byKey.get(key(m)) || {}
    if (m.physicalDelta.gt(0)) { group.firstIn ??= m; group.lastIn = m } else group.lastOut = m
    byKey.set(key(m), group)
  }
  return balances.map(b => {
    const h = byKey.get(key(b)) || {}
    const retainedDays = daysWithoutOutbound(now, h.lastOut?.effectiveAt, h.firstIn?.effectiveAt)
    return { ...base(b.product, b.warehouse, b.inventoryUnit), qty: Number(b.physicalQty), firstInAt: reportTimestamp(h.firstIn?.effectiveAt), lastInAt: reportTimestamp(h.lastIn?.effectiveAt), lastOutAt: reportTimestamp(h.lastOut?.effectiveAt), lastInQty: h.lastIn ? Number(h.lastIn.physicalDelta) : null, lastOutQty: h.lastOut ? Number(h.lastOut.physicalDelta.abs()) : null, retainedDays, stagnantDays: q.stagnantDays, isStagnant: retainedDays == null ? null : retainedDays >= q.stagnantDays ? '是' : '否' }
  })
}
