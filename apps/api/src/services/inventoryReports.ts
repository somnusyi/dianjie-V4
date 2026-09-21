import { Prisma } from '@dianjie/db'
import { z } from 'zod'
import { businessDateKey, businessDateRangeInclusive } from '../lib/businessTime'

export const reportIds = ['realtime', 'movements', 'summary', 'transfer-detail', 'transfer-summary'] as const
export type ReportId = typeof reportIds[number]
export type ReportRow = Record<string, string | number | null>
export type ReportColumn = { key: string; label: string; kind: 'text' | 'number'; group?: string }
const c = (key: string, label: string, kind: 'text' | 'number' = 'text', group?: string): ReportColumn => ({ key, label, kind, group })
const item = [c('name', '物品名称'), c('code', '物品编码'), c('spec', '规格型号'), c('category', '物品类别'), c('unit', '单位')]
const org = [c('org', '机构名称'), c('warehouse', '仓库')]
const flow = (prefix: string, group: string) => [c(`${prefix}Qty`, '数量', 'number', group), c(`${prefix}Amount`, '金额', 'number', group)]
const transfer = [...item, c('org', '调出机构'), c('warehouse', '调出仓库'), c('target', '调入机构'), c('targetWarehouse', '调入仓库'), c('cost', '调出成本单价', 'number'), c('settlement', '结算单价', 'number'), c('transferQty', '调拨数量', 'number'), c('outAmount', '调出金额', 'number'), c('inAmount', '调入金额', 'number')]
export const reportDefinitions: Record<ReportId, { title: string; note: string; columns: ReportColumn[] }> = {
  realtime: { title: '实时库存查询表', note: '预计入库为已提交采购单尚未合格验收的数量；预计出库为当前预占数量。数量均为库存单位。', columns: [...item, c('conversion', '单位换算'), ...org, c('qty', '库存量', 'number'), c('amount', '库存金额', 'number'), c('price', '均价', 'number'), c('expectedIn', '预计入库', 'number'), c('expectedOut', '预计出库', 'number')] },
  movements: { title: '出入库明细表', note: '金额仅展示有冻结税率依据的不含税金额；无依据显示“—”。预占、释放不计作实物出入库；冲销保留反向记录。', columns: [...item, ...org, c('doc', '出入库单据号'), c('type', '出入库类型'), c('upstream', '上游单据号'), c('upstreamType', '上游单据类型'), c('reason', '原因类型'), c('adjustment', '调整单标识'), c('counterparty', '对方机构'), c('upstreamDate', '上游单据日期'), c('date', '出入库日期'), c('inQty', '数量', 'number', '入库'), c('inPrice', '单价（不含税）', 'number', '入库'), c('inAmount', '金额（不含税）', 'number', '入库'), c('outQty', '数量', 'number', '出库'), c('outPrice', '单价（不含税）', 'number', '出库'), c('outAmount', '金额（不含税）', 'number', '出库')] },
  summary: { title: '出入库汇总表', note: '金额按库存台账成本口径。期末 = 期初 + 入库 − 出库；类型筛选仅选取期间发生该类型的物品，余额仍包含全部类型。纯金额调整按金额方向计入。', columns: [...item, ...org, c('type', '出入库类型'), ...flow('opening', '期初'), ...flow('in', '入库'), ...flow('out', '出库'), ...flow('closing', '期末结余')] },
  'transfer-detail': { title: '机构间调拨明细表', note: '统计已发货、已收货的门店间调拨登记；金额采用建单时确认的价格快照，待发货和已撤回不计入。调拨登记不改写门店盘点库存。', columns: [c('doc', '调拨单号'), c('date', '调拨日期'), ...transfer] },
  'transfer-summary': { title: '机构间调拨汇总表', note: '按物品、库存单位及调出/调入门店汇总已发货、已收货的调拨登记；单价按数量加权。', columns: transfer },
}
const text = z.string().trim().max(120).default('')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(+d) && d.toISOString().slice(0, 10) === v }, '日期无效')
export const reportQuerySchema = z.object({
  start: date.default(() => `${businessDateKey().slice(0, 7)}-01`), end: date.default(() => businessDateKey()),
  warehouseId: text, keyword: text, category: text, unit: text, org: text, warehouse: text,
  type: text, doc: text, upstream: text, upstreamType: text, reason: text, adjustment: z.enum(['', '是', '否']).default(''), counterparty: text, target: text, targetWarehouse: text, conversion: text,
  ranges: z.string().max(3000).default('{}').transform((value, ctx) => {
    try { const r = z.record(z.object({ min: z.number().finite().optional(), max: z.number().finite().optional() }).refine(v => v.min == null || v.max == null || v.min <= v.max, '最小值不能大于最大值')).parse(JSON.parse(value)); return r }
    catch { ctx.addIssue({ code: 'custom', message: '数值范围无效' }); return z.NEVER }
  }),
  page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), sort: text, direction: z.enum(['asc', 'desc']).default('asc'), export: z.enum(['0', '1']).default('0'),
}).refine(q => q.start <= q.end, '开始日期不能晚于结束日期')
export type ReportQuery = z.infer<typeof reportQuerySchema>
export const movementLabels: Record<string, string> = { OPENING_BALANCE: '期初建账', MANUAL_INBOUND: '手工入库', UPSTREAM_RECEIPT: '采购入库', ORDER_OUTBOUND: '出库', ADJUSTMENT: '库存调整', LOSS: '报损', REVERSAL: '冲销' }
const sourceLabels: Record<string, string> = { WarehouseManualInbound: '手工入库单', WarehouseBatchManualInbound: '批量入库单', WarehouseManualOutbound: '手工出库单', WarehousePhysicalCount: '库存盘点单', WarehouseManualInboundReversal: '入库冲销单', WarehouseDocValueAdjust: '单据金额调整', MeituanDailyPackage: '每日采购数据包', UpstreamReceiptReversal: '采购收货冲销', UpstreamArrivalClaim: '采购到货差异', LossClaimReversal: '报损冲销', DeliveryOrderShipCancel: '配送撤销', ReceiptRejectionReversal: '拒收冲销' }
const dec = (n: any) => new Prisma.Decimal(n ?? 0)
const num = (n: any) => Number(n ?? 0)
const LIMIT = 20000
function bounded<T>(rows: T[]): T[] {
  if (rows.length > LIMIT) throw Object.assign(new Error('查询数据超过 20,000 条，请缩小日期、仓库或物品范围后重试'), { statusCode: 422 })
  return rows
}
function base(product: any, warehouse: any, unit: string): ReportRow {
  return { productId: product.id, name: product.name, code: product.code, spec: product.spec, category: product.category, unit, org: '总部', warehouse: warehouse.name, warehouseId: warehouse.id }
}
export function filterReportRows(rows: ReportRow[], q: ReportQuery) {
  return rows.filter(r => {
    for (const key of ['org', 'warehouse', 'category', 'unit', 'upstreamType', 'adjustment', 'target', 'targetWarehouse']) if (q[key as keyof ReportQuery] && r[key] !== q[key as keyof ReportQuery]) return false
    for (const key of ['doc', 'upstream', 'reason', 'counterparty', 'conversion']) if (q[key as keyof ReportQuery] && !String(r[key] ?? '').includes(String(q[key as keyof ReportQuery]))) return false
    for (const [key, range] of Object.entries(q.ranges)) {
      if (r[key] == null || typeof r[key] !== 'number') return false
      if (range.min != null && Number(r[key]) < range.min || range.max != null && Number(r[key]) > range.max) return false
    }
    return true
  })
}
export function aggregateTransfers(rows: ReportRow[]) {
  const groups = new Map<string, ReportRow>()
  for (const r of rows) {
    const key = JSON.stringify([r.productId, r.fromStoreId, r.targetId, r.unit])
    const g = groups.get(key) || { ...r, transferQty: 0, outAmount: 0, inAmount: 0 }
    g.transferQty = num(dec(g.transferQty).plus(r.transferQty!))
    g.outAmount = num(dec(g.outAmount).plus(r.outAmount!))
    g.inAmount = g.inAmount == null || r.inAmount == null ? null : num(dec(g.inAmount).plus(r.inAmount))
    groups.set(key, g)
  }
  return [...groups.values()].map(g => ({ ...g, cost: num(dec(g.outAmount).div(g.transferQty!)), settlement: g.inAmount == null ? null : num(dec(g.inAmount).div(g.transferQty!)) }))
}

/** All source reads share a repeatable-read transaction; list and export use this same projection. */
export async function loadInventoryReport(tx: Prisma.TransactionClient, tenantId: string, id: ReportId, q: ReportQuery) {
  const range = businessDateRangeInclusive(q.start, q.end)
  const product: Prisma.ProductWhereInput = { tenantId,
    ...(q.category ? { category: q.category } : {}),
    ...(q.keyword ? { AND: q.keyword.split(/\s+/).map(term => ({ OR: [{ name: { contains: term, mode: 'insensitive' as const } }, { code: { contains: term, mode: 'insensitive' as const } }] })) } : {}),
  }
  const scope = { tenantId, ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}), product }
  const warehouses = await tx.warehouse.findMany({ where: { tenantId }, select: { id: true, name: true, isDefault: true } })
  let rows: ReportRow[] = []
  if (id === 'realtime') {
    const balances = bounded(await tx.warehouseLedgerBalance.findMany({ where: scope, include: { product: true, warehouse: true }, take: LIMIT + 1 }))
    const incoming = bounded(await tx.upstreamPurchaseOrderLine.findMany({ where: { tenantId, product, purchaseOrder: { tenantId, ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}), status: { in: ['SUBMITTED_TO_SUPPLIER', 'CHANGE_PROPOSED', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_RECEIVED'] } } }, include: { product: true, purchaseOrder: { select: { warehouseId: true, warehouse: true } } }, take: LIMIT + 1 }))
    const expected = new Map<string, Prisma.Decimal>()
    for (const l of incoming) { const key = `${l.purchaseOrder.warehouseId}/${l.productId}/${l.inventoryUnit}`; expected.set(key, (expected.get(key) || dec(0)).plus(Prisma.Decimal.max(0, (l.confirmedQty ?? l.orderedQty).minus(l.receivedQty)).mul(l.inventoryUnitsPerPurchaseUnit))) }
    rows = balances.map(b => ({ ...base(b.product, b.warehouse, b.inventoryUnit), conversion: b.product.inventoryUnitsPerPurchaseUnit && b.product.purchaseUnit ? `1 ${b.product.purchaseUnit} = ${b.product.inventoryUnitsPerPurchaseUnit} ${b.product.inventoryUnit}` : null, qty: num(b.physicalQty), amount: num(b.inventoryValue), price: num(b.averageUnitCost), expectedIn: num(expected.get(`${b.warehouseId}/${b.productId}/${b.inventoryUnit}`)), expectedOut: num(b.reservedQty) }))
    const present = new Set(balances.map(b => `${b.warehouseId}/${b.productId}/${b.inventoryUnit}`))
    for (const l of incoming) {
      const key = `${l.purchaseOrder.warehouseId}/${l.productId}/${l.inventoryUnit}`
      if (present.has(key)) continue
      present.add(key)
      rows.push({ ...base(l.product, l.purchaseOrder.warehouse, l.inventoryUnit), conversion: `1 ${l.purchaseUnit} = ${l.inventoryUnitsPerPurchaseUnit} ${l.inventoryUnit}`, qty: 0, amount: 0, price: null, expectedIn: num(expected.get(key)), expectedOut: 0 })
    }
  } else if (id === 'summary') {
    // Aggregate all historical deltas in PostgreSQL, including reversals and value-only corrections.
    const sums = await tx.warehouseLedgerMovement.groupBy({ by: ['warehouseId', 'productId', 'inventoryUnit'], where: { ...scope, effectiveAt: { lt: range.start } }, _sum: { physicalDelta: true, valueDelta: true } })
    const period = bounded(await tx.warehouseLedgerMovement.findMany({ where: { ...scope, effectiveAt: { gte: range.start, lt: range.endExclusive }, type: { notIn: ['ORDER_RESERVED', 'ORDER_RELEASED'] } }, include: { product: true, warehouse: true }, take: LIMIT + 1 }))
    const products = bounded(await tx.product.findMany({ where: product, take: LIMIT + 1 }))
    const productsById = new Map(products.map(p => [p.id, p]))
    const groups = new Map<string, ReportRow>()
    const key = (r: { warehouseId: string; productId: string; inventoryUnit: string }) => `${r.warehouseId}/${r.productId}/${r.inventoryUnit}`
    const fresh = (p: any, w: any, unit: string): ReportRow => ({ ...base(p, w, unit), type: q.type || '全部', openingQty: 0, openingAmount: 0, inQty: 0, inAmount: 0, outQty: 0, outAmount: 0, closingQty: 0, closingAmount: 0 })
    for (const s of sums) { const p = productsById.get(s.productId); const w = warehouses.find(w => w.id === s.warehouseId); if (p && w) groups.set(key(s), { ...fresh(p, w, s.inventoryUnit), openingQty: num(s._sum.physicalDelta), openingAmount: num(s._sum.valueDelta) }) }
    const matching = new Set<string>()
    for (const m of period) {
      const k = key(m); const g = groups.get(k) || fresh(m.product, m.warehouse, m.inventoryUnit)
      if (!q.type || movementLabels[m.type] === q.type) matching.add(k)
      const inbound = m.physicalDelta.gt(0) || m.physicalDelta.eq(0) && m.valueDelta.gte(0)
      const prefix = inbound ? 'in' : 'out'
      g[`${prefix}Qty`] = num(dec(g[`${prefix}Qty`]).plus(inbound ? m.physicalDelta : m.physicalDelta.negated()))
      g[`${prefix}Amount`] = num(dec(g[`${prefix}Amount`]).plus(inbound ? m.valueDelta : m.valueDelta.negated()))
      groups.set(k, g)
    }
    rows = [...groups].filter(([k]) => !q.type || matching.has(k)).map(([, g]) => ({ ...g, closingQty: num(dec(g.openingQty).plus(g.inQty!).minus(g.outQty!)), closingAmount: num(dec(g.openingAmount).plus(g.inAmount!).minus(g.outAmount!)) }))
  } else if (id.startsWith('transfer')) {
    const transfers = bounded(await tx.storeTransferItem.findMany({ where: { product: { tenantId }, ...(q.keyword ? { OR: [{ name: { contains: q.keyword, mode: 'insensitive' } }, { code: { contains: q.keyword, mode: 'insensitive' } }] } : {}), ...(q.category ? { category: q.category } : {}),
      transfer: { tenantId, status: { in: ['SHIPPED', 'RECEIVED'] }, transferDate: { gte: new Date(`${q.start}T00:00:00Z`), lte: new Date(`${q.end}T00:00:00Z`) }, ...(q.org ? { fromStore: { name: q.org } } : {}), ...(q.target ? { toStore: { name: q.target } } : {}) },
    }, include: { transfer: { include: { fromStore: true, toStore: true } } }, take: LIMIT + 1 }))
    rows = transfers.map(l => ({ productId: l.productId, name: l.name, code: l.code, spec: l.spec, category: l.category, unit: l.unit, org: l.transfer.fromStore.name, fromStoreId: l.transfer.fromStoreId, warehouse: null, warehouseId: null, target: l.transfer.toStore.name, targetId: l.transfer.toStoreId, targetWarehouse: null, doc: l.transfer.no, date: businessDateKey(l.transfer.transferDate), transferQty: num(l.quantity), cost: num(l.cost), settlement: num(l.settlement), outAmount: num(l.outAmount), inAmount: num(l.inAmount) }))
    if (id === 'transfer-summary') rows = aggregateTransfers(rows)
  } else {
    const movements = bounded(await tx.warehouseLedgerMovement.findMany({ where: { ...scope, effectiveAt: { gte: range.start, lt: range.endExclusive }, type: { notIn: ['ORDER_RESERVED', 'ORDER_RELEASED'] } }, include: { product: true, warehouse: true, supplier: true, docLines: { where: { tenantId }, include: { doc: true } }, upstreamReceiptLine: { include: { receipt: { include: { purchaseOrder: true } }, purchaseOrderLine: true } } }, orderBy: [{ effectiveAt: 'desc' }, { id: 'asc' }], take: LIMIT + 1 }))
    const deliveries = await tx.deliveryOrder.findMany({ where: { tenantId, id: { in: movements.filter(m => m.sourceType === 'DeliveryOrder').map(m => m.sourceId) } }, include: { store: true, purchaseOrder: true, items: true } })
    const byDelivery = new Map(deliveries.map(d => [d.id, d]))
    for (const m of movements) {
      const d = byDelivery.get(m.sourceId)
      const receiptLine = m.upstreamReceiptLine?.tenantId === tenantId ? m.upstreamReceiptLine : null
      const doc = m.docLines[0]?.doc
      const inbound = m.physicalDelta.gt(0) || m.physicalDelta.eq(0) && m.valueDelta.gte(0)
      // No blanket tax=0 fallback: warehouse cost is not necessarily a tax-exclusive amount.
      const net = receiptLine ? receiptLine.receipt.purchaseOrder.taxInclusive ? receiptLine.payableAmount.div(dec(1).plus(receiptLine.purchaseOrderLine.taxRate)) : receiptLine.payableAmount : null
      const absQty = m.physicalDelta.abs()
      rows.push({ ...base(m.product, m.warehouse, m.inventoryUnit), doc: doc?.docNo || receiptLine?.receipt.no || d?.no || null, type: movementLabels[m.type] || m.type, upstream: receiptLine?.receipt.purchaseOrder.no || d?.purchaseOrder.no || null, upstreamType: receiptLine ? '上游采购单' : d ? '门店订货单' : sourceLabels[m.sourceType] || '其他库存单据', reason: doc?.reason || movementLabels[m.type] || m.type, adjustment: ['ADJUSTMENT', 'REVERSAL'].includes(m.type) ? '是' : '否', counterparty: d?.store.name || m.supplier?.name || m.sourceName || null, upstreamDate: receiptLine ? businessDateKey(receiptLine.receipt.purchaseOrder.createdAt) : d ? businessDateKey(d.purchaseOrder.createdAt) : null, date: businessDateKey(m.effectiveAt), inQty: inbound ? num(absQty) : 0, outQty: inbound ? 0 : num(absQty), inAmount: inbound ? net == null ? null : num(net) : 0, outAmount: inbound ? 0 : net == null ? null : num(net), inPrice: inbound && net != null && !absQty.eq(0) ? num(net.div(absQty)) : null, outPrice: !inbound && net != null && !absQty.eq(0) ? num(net.div(absQty)) : null })
    }
    if (id === 'movements' && q.type) rows = rows.filter(r => r.type === q.type)
  }
  rows = filterReportRows(rows, q)
  const definition = reportDefinitions[id]
  const sort = definition.columns.some(c => c.key === q.sort) ? q.sort : id === 'movements' || id === 'transfer-detail' ? 'date' : 'code'
  rows.sort((a, b) => { const av = a[sort], bv = b[sort]; if (av == null) return bv == null ? 0 : 1; if (bv == null) return -1; return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })) * (q.direction === 'desc' ? -1 : 1) })
  const total = rows.length; const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)))
  return { ...definition, id, warehouses, rows: q.export === '1' ? rows : rows.slice((page - 1) * q.pageSize, page * q.pageSize), total, page, pageSize: q.pageSize, generatedAt: new Date().toISOString() }
}
