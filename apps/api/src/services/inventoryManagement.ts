import { Prisma } from '@dianjie/db'
import { z } from 'zod'
import contract from './inventory-management-contract.json'
import { businessDateKey, businessDateRangeInclusive } from '../lib/businessTime'

export const managementPages = contract
export type ManagementRow = Record<string, string | number | null>
const validDate = z.string().refine(s => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s), '日期格式不正确')
export const managementQuerySchema = z.object({
  start: validDate.default(''), end: validDate.default(''), dateField: z.enum(['date', 'createdAt']).default('date'),
  filters: z.string().default('{}').transform((value, ctx) => {
    try { return z.record(z.string().max(200)).parse(JSON.parse(value)) }
    catch { ctx.addIssue({ code: 'custom', message: '筛选条件不正确' }); return z.NEVER }
  }),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  export: z.enum(['1']).optional(),
}).refine(q => !q.start || !q.end || q.start <= q.end, '开始日期不能晚于结束日期')
type Query = z.infer<typeof managementQuerySchema>
const textMatch = (value: unknown, query: string) => String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())
const timestamp = (value: Date | null | undefined) => value ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value) : null
const day = (value: Date | null | undefined) => value ? businessDateKey(value) : null
function bounded<T>(rows: T[], max = 10000): T[] {
  if (rows.length > max) throw Object.assign(new Error('记录过多，请缩小日期、仓库或物品范围后查询。'), { statusCode: 422 })
  return rows
}
const absentSources: Record<string, string> = {
  'purchase-return': '当前系统尚未建立独立的采购退货出库单，暂不能提供对应单据记录。',
  'multi-count': '当前系统尚未建立多人盘点单，普通盘点记录仍在“盘点单”中查看。',
  profit: '当前系统尚未生成独立盘盈单，盘点盈亏金额可在“盘点单”中查看。',
  loss: '当前系统尚未生成独立盘亏单，盘点盈亏金额可在“盘点单”中查看。',
}
const optionFields = new Set(['org', 'warehouse', 'supplier', 'status', 'review', 'printed', 'difference', 'generated', 'reconciliation', 'invoice', 'stockStatus', 'category', 'countType', 'reason', 'supplierAccount'])

export async function loadInventoryManagement(tx: Prisma.TransactionClient, tenantId: string, id: string, q: Query) {
  const config = contract.find(p => p.id === id)!
  const allowed = new Set([...config.filters, ...config.advanced].map(f => f.key))
  if (Object.keys(q.filters).some(key => !allowed.has(key))) throw Object.assign(new Error('该页面不支持此筛选条件'), { statusCode: 400 })
  const sourceAvailable = !absentSources[id]
  let note = absentSources[id] || ''
  let rows: ManagementRow[] = []
  const supportedFilters = new Set(['no', 'org', 'warehouse', 'item', 'status', 'note'])
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } })
  const org = tenant?.name ?? null
  const dateRange = (field: string) => {
    if (!q.start && !q.end) return {}
    // PostgreSQL DATE 不带时区；Prisma 会将时间值转换为日期，不能使用上海零点的 UTC 前一天。
    if (field === 'countDate' && q.dateField === 'date') return { countDate: {
      ...(q.start ? { gte: new Date(`${q.start}T00:00:00Z`) } : {}),
      ...(q.end ? { lt: new Date(new Date(`${q.end}T00:00:00Z`).getTime() + 86400000) } : {}),
    } }
    return { [q.dateField === 'createdAt' ? 'createdAt' : field]: {
      ...(q.start ? { gte: businessDateRangeInclusive(q.start, q.start).start } : {}),
      ...(q.end ? { lt: businessDateRangeInclusive(q.end, q.end).endExclusive } : {}),
    } }
  }
  const productMatch = q.filters.item ? { OR: [{ name: { contains: q.filters.item, mode: 'insensitive' as const } }, { code: { contains: q.filters.item, mode: 'insensitive' as const } }] } : {}
  if (id === 'other-in' || id === 'other-out') {
    supportedFilters.add('review'); supportedFilters.add('reason')
    const docs = bounded(await tx.warehouseDoc.findMany({
      where: { tenantId, type: id === 'other-in' ? 'MANUAL_INBOUND' : 'MANUAL_OUTBOUND', ...dateRange('effectiveAt'),
        ...(q.filters.warehouse ? { warehouseId: { in: (await tx.warehouse.findMany({ where: { tenantId, name: { contains: q.filters.warehouse, mode: 'insensitive' } }, select: { id: true } })).map(w => w.id) } } : {}),
        ...(q.filters.item ? { lines: { some: { tenantId, productName: { contains: q.filters.item, mode: 'insensitive' } } } } : {}),
      }, orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }], take: 10001,
    }))
    const [warehouses, users] = await Promise.all([
      tx.warehouse.findMany({ where: { tenantId, id: { in: docs.map(d => d.warehouseId) } }, select: { id: true, name: true } }),
      tx.user.findMany({ where: { tenantId, id: { in: docs.flatMap(d => d.createdById ? [d.createdById] : []) } }, select: { id: true, name: true } }),
    ])
    const names = new Map(users.map(u => [u.id, u.name])); const warehouseNames = new Map(warehouses.map(w => [w.id, w.name]))
    rows = docs.map(d => ({ id: d.id, no: d.docNo, date: day(d.effectiveAt), org, warehouse: warehouseNames.get(d.warehouseId) ?? null,
      reason: d.reason, amount: Number(d.totalAmount), status: d.status === 'CONFIRMED' ? '已审核' : '未审核',
      review: d.reviewStatus === 'REVIEWED' ? '已复审' : '未复审', createdAt: timestamp(d.createdAt), creator: d.createdById ? names.get(d.createdById) ?? null : null, note: d.note,
    }))
    note = '数据来自现有仓库单据。未记录的上游单号、第三方单号及打印状态显示为“—”。物品按单据中的名称查询。'
  } else if (id === 'purchase-in') {
    supportedFilters.add('supplier'); supportedFilters.add('upstream')
    const receipts = bounded(await tx.upstreamReceipt.findMany({
      where: { tenantId, ...dateRange('postedAt'), supplier: { tenantId },
        ...(q.filters.warehouse ? { warehouse: { tenantId, name: { contains: q.filters.warehouse, mode: 'insensitive' } } } : {}),
        ...(q.filters.item ? { lines: { some: { tenantId, product: { tenantId, ...productMatch } } } } : {}),
      }, include: { supplier: { select: { name: true } }, warehouse: { select: { name: true } }, purchaseOrder: { select: { no: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10001,
    }))
    const users = await tx.user.findMany({ where: { tenantId, id: { in: receipts.map(r => r.createdById) } }, select: { id: true, name: true } })
    const names = new Map(users.map(u => [u.id, u.name]))
    const statuses = { DRAFT: '草稿', INSPECTING: '验收中', PENDING_REVIEW: '待复核', POSTED: '已入库', REVERSED: '已冲销' }
    rows = receipts.map(r => ({ id: r.id, no: r.no, date: day(r.postedAt), upstream: r.purchaseOrder.no, org, warehouse: r.warehouse.name,
      supplier: r.supplier.name, amount: Number(r.payableAmount), status: statuses[r.status], createdAt: timestamp(r.createdAt), creator: names.get(r.createdById) ?? null, note: r.note,
      attachments: Array.isArray(r.evidence) ? `${r.evidence.length} 项` : null,
    }))
    note = '数据来自采购收货单，入库日期取实际过账日期；未入库单据可按创建时间查询。现有验收复核不等同于入库后复审，复审状态显示“—”；附件列显示收货凭证数量。'
  } else if (id === 'count') {
    supportedFilters.delete('warehouse'); supportedFilters.add('difference')
    const counts = bounded(await tx.inventoryCount.findMany({
      where: { tenantId, store: { tenantId }, ...dateRange('countDate'),
        ...(q.filters.item ? { items: { some: { productNameSnapshot: { contains: q.filters.item, mode: 'insensitive' } } } } : {}),
      }, include: { store: { select: { name: true } } }, orderBy: [{ countDate: 'desc' }, { id: 'desc' }], take: 10001,
    }))
    const users = await tx.user.findMany({ where: { tenantId, id: { in: counts.map(c => c.createdById) } }, select: { id: true, name: true } })
    const names = new Map(users.map(u => [u.id, u.name]))
    const statuses = { DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消', REVERSED: '已冲销' }
    rows = counts.map(c => ({ id: c.id, no: c.no, date: c.countDate.toISOString().slice(0, 10), org: c.store.name, itemCount: c.itemCount,
      bookAmount: Number(c.totalBookValue), actualAmount: Number(c.totalCountedValue), differenceAmount: Number(c.totalDifferenceValue),
      status: statuses[c.status], difference: c.countedCount < c.itemCount ? '未盘完' : c.differenceCount ? '有差异' : '无差异',
      auditedAt: day(c.confirmedAt), createdAt: timestamp(c.createdAt), creator: names.get(c.createdById) ?? null, note: c.note,
    }))
    note = '数据来自现有门店盘点单。仓库、盘点类型、盘点方式、打印状态和盘点方案未记录，显示“—”；未盘完的金额为当前已录入金额。'
  } else if (id === 'limits') {
    supportedFilters.clear(); ['org', 'warehouse', 'category', 'item'].forEach(k => supportedFilters.add(k))
    const balances = bounded(await tx.warehouseLedgerBalance.findMany({ where: { tenantId,
      warehouse: { tenantId, ...(q.filters.warehouse ? { name: { contains: q.filters.warehouse, mode: 'insensitive' } } : {}) },
      product: { tenantId, ...productMatch, ...(q.filters.category ? { category: { contains: q.filters.category, mode: 'insensitive' } } : {}) },
    }, include: { warehouse: { select: { code: true, name: true } }, product: { select: { code: true, name: true, spec: true, category: true } } }, orderBy: [{ warehouseId: 'asc' }, { productId: 'asc' }], take: 10001 }))
    const end = businessDateRangeInclusive(businessDateKey(), businessDateKey()).start
    const dayMs = 86400000
    const movements = balances.length ? bounded(await tx.warehouseLedgerMovement.findMany({ where: {
      tenantId, effectiveAt: { gte: new Date(end.getTime() - 60 * dayMs), lt: end }, physicalDelta: { lt: 0 }, reversal: { is: null },
      OR: [{ type: { in: ['ORDER_OUTBOUND', 'LOSS'] } }, { sourceType: 'WarehouseManualOutbound', type: 'ADJUSTMENT' }],
      warehouseId: { in: [...new Set(balances.map(b => b.warehouseId))] }, productId: { in: [...new Set(balances.map(b => b.productId))] },
    }, select: { warehouseId: true, productId: true, inventoryUnit: true, effectiveAt: true, physicalDelta: true }, take: 50001 }), 50000) : []
    const totals = new Map<string, Record<string, number>>()
    const unitHistory = new Map<string, { unit: string; at: number }[]>()
    for (const m of movements) {
      const key = `${m.warehouseId}:${m.productId}:${m.inventoryUnit}`; const values = totals.get(key) || {}
      const productKey = `${m.warehouseId}:${m.productId}`
      const history = unitHistory.get(productKey) || []
      history.push({ unit: m.inventoryUnit, at: m.effectiveAt.getTime() }); unitHistory.set(productKey, history)
      for (const days of [7, 14, 21, 30, 60]) if (m.effectiveAt.getTime() >= end.getTime() - days * dayMs) values[`avg${days}`] = (values[`avg${days}`] || 0) - Number(m.physicalDelta) / days
      totals.set(key, values)
    }
    rows = balances.map(b => ({ id: b.id, orgCode: tenant?.slug ?? null, org, warehouseCode: b.warehouse.code, warehouse: b.warehouse.name,
      code: b.product.code, name: b.product.name, spec: b.product.spec, category: b.product.category, unit: b.inventoryUnit, currentQty: Number(b.physicalQty),
      ...Object.fromEntries([7, 14, 21, 30, 60].map(days => [`avg${days}`,
        unitHistory.get(`${b.warehouseId}:${b.productId}`)?.some(m => m.unit !== b.inventoryUnit && m.at >= end.getTime() - days * dayMs)
          ? null : totals.get(`${b.warehouseId}:${b.productId}:${b.inventoryUnit}`)?.[`avg${days}`] ?? 0,
      ])),
    }))
    note = '当前库存来自仓库台账，单位为库存单位；日均出库量按截至昨日的完整自然日计算，已撤销流水不计入，历史单位不一致时显示“—”。仓库级上下限、安全库存及天数尚未配置，显示“—”，库存状态暂不可判断。'
  }
  const options: Record<string, string[]> = {}
  for (const f of [...config.filters, ...config.advanced]) {
    options[f.key] = optionFields.has(f.key)
      ? [...new Set(rows.flatMap(r => r[f.key] == null ? [] : [String(r[f.key])]))].sort()
      : []
  }
  const exact = new Set(['status', 'review', 'printed', 'difference', 'generated', 'stockStatus', 'invoice', 'reconciliation'])
  rows = rows.filter(row => Object.entries(q.filters).every(([key, value]) => !value || (key === 'item' ? true : exact.has(key) ? row[key] === value : textMatch(row[key], value))))
  const total = rows.length
  const totals = Object.fromEntries(config.columns.filter(c => ['amount', 'bookAmount', 'actualAmount', 'differenceAmount'].includes(c.key)).map(c => [c.key,
    Number(rows.reduce((sum, r) => sum.plus(r[c.key] == null ? 0 : Number(r[c.key])), new Prisma.Decimal(0)).toDecimalPlaces(6)),
  ]))
  const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)))
  const resultRows = (q.export ? rows : rows.slice((page - 1) * q.pageSize, page * q.pageSize)).map((r, i) => ({
    id: r.id, ...Object.fromEntries(config.columns.map(c => [c.key, c.key === 'seq' ? (q.export ? 0 : (page - 1) * q.pageSize) + i + 1 : r[c.key] ?? null])),
  }))
  return { id, title: config.title, columns: config.columns, rows: resultRows, total, totals, page, pageSize: q.pageSize, options,
    supportedFilters: sourceAvailable ? [...supportedFilters] : [], sourceAvailable, note, generatedAt: timestamp(new Date()) }
}
