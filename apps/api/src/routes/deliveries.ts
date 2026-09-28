import { FastifyPluginAsync } from 'fastify'
import ExcelJS from 'exceljs'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isStoreScoped, isSupplierRole, resolveActiveStore } from '../lib/auth-scope'
import { requireSupplierCapability } from '../lib/supplier-access'
import { allowsSupplyDataRead, hasInternalSupplyChainCapability, isInternalSupplyChainRole, supplyDataReadScope } from '../lib/internal-supply-chain-access'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'
import { calendarDateSchema } from '../lib/calendar-date'
import {
  addDeliveryItemInTransaction,
  changeDeliveryItemQuantityInTransaction,
  removeDeliveryItemInTransaction,
} from '../services/deliveryItemRemoval'
import { publicDeliveryMarkerFilter } from '../services/shipmentDraftMarker'
import { loadDeliveryProfitProjections } from '../services/deliveryProfitProjection'

const listQuerySchema = z.object({
  status: z.enum(['DRAFT', 'SHIPPED', 'DELIVERED', 'RECEIVED', 'CANCELLED']).optional(),
  storeId: z.string().optional(),
  supplierId: z.string().optional(),
  productId: z.string().optional(),
  keyword: z.string().trim().max(80).optional(),
  dateFrom: calendarDateSchema.optional(),
  dateTo: calendarDateSchema.optional(),
  page: z.coerce.number().int().positive().max(100_000).default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
}).refine(q => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
  message: '开始日期不能晚于结束日期',
  path: ['dateFrom'],
})

export const DELIVERY_EXPORT_MAX_ROWS = 10_000

export function exceedsDeliveryExportLimit(rowCount: number) {
  return rowCount > DELIVERY_EXPORT_MAX_ROWS
}

async function deliveryProfitById(user: any, deliveries: any[]) {
  if (!isInternalSupplyChainRole(user?.role)) return new Map()
  return loadDeliveryProfitProjections(prisma, user.tenantId, deliveries.map(delivery => ({
    id: String(delivery.id),
    items: (delivery.items || []).map((item: any) => ({
      id: String(item.id),
      productId: String(item.productId),
      purchaseOrderItemId: item.purchaseOrderItemId ? String(item.purchaseOrderItemId) : null,
      orderedQtySnapshot: item.orderedQtySnapshot,
      shippedQty: item.shippedQty,
      unitPriceSnapshot: item.unitPriceSnapshot,
      amount: item.amount,
    })),
  })))
}

function attachDeliveryProfit(delivery: any, profitById: Map<string, any>) {
  const profitability = profitById.get(String(delivery.id)) || null
  const lines = new Map((profitability?.lines || []).map((line: any) => [String(line.itemId), line]))
  return {
    ...delivery,
    ...(profitability ? { profitability } : {}),
    items: (delivery.items || []).map((raw: any) => ({
      ...withDocumentProductSnapshot(raw),
      ...(lines.has(String(raw.id)) ? { profitability: lines.get(String(raw.id)) } : {}),
    })),
  }
}

function buildDeliveryListWhere(q: z.infer<typeof listQuerySchema>, user: any) {
  const { role, supplierId: actorSupplierId } = user
  const where: any = supplyDataReadScope(user)
  if (q.storeId) {
    if (isStoreScoped(role)) resolveActiveStore(user, q.storeId)
    where.storeId = q.storeId
  }
  if (isSupplierRole(role)) where.supplierId = requireSupplierCapability(role, actorSupplierId, 'order.read')
  else if (q.supplierId) where.supplierId = q.supplierId
  if (q.status) where.status = q.status
  else where.status = { not: 'DRAFT' }
  const and: any[] = [publicDeliveryMarkerFilter()]
  if (q.productId) and.push({ items: { some: { productId: q.productId } } })
  if (q.keyword) {
    and.push({
      OR: [
        { no: { contains: q.keyword, mode: 'insensitive' } },
        { purchaseOrder: { no: { contains: q.keyword, mode: 'insensitive' } } },
        { store: { name: { contains: q.keyword, mode: 'insensitive' } } },
        {
          items: {
            some: {
              OR: [
                { productNameSnapshot: { contains: q.keyword, mode: 'insensitive' } },
                { productCodeSnapshot: { contains: q.keyword, mode: 'insensitive' } },
                { productSpecSnapshot: { contains: q.keyword, mode: 'insensitive' } },
                {
                  product: {
                    OR: [
                      { name: { contains: q.keyword, mode: 'insensitive' } },
                      { code: { contains: q.keyword, mode: 'insensitive' } },
                      { spec: { contains: q.keyword, mode: 'insensitive' } },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    })
  }
  where.AND = and
  if (q.dateFrom || q.dateTo) {
    where.createdAt = {
      ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00+08:00`) } : {}),
      ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59.999+08:00`) } : {}),
    }
  }
  return where
}

const shanghaiDateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

function formatShanghaiDateTime(value: Date | string | null | undefined) {
  if (!value) return ''
  const parts = Object.fromEntries(shanghaiDateTime.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

const deliveryItemQuantitySchema = z.coerce.number()
  .nonnegative('新增商品数量不能小于 0')
  .max(99_999_999.99, '新增商品数量超过系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '数量最多保留 2 位小数')

const deliveryAdditionSchema = z.object({
  productId: z.string().trim().min(1).optional(),
  customProduct: z.object({
    name: z.string().trim().min(1, '商品名称必填').max(80, '商品名称不能超过 80 字'),
    unit: z.string().trim().min(1, '商品单位必填').max(16, '商品单位不能超过 16 字')
      .refine(value => !/^\d/.test(value), '单位不能以数字开头'),
    unitPrice: z.coerce.number()
      .nonnegative('商品价格不能为负')
      .max(99_999_999.99, '商品价格超过系统上限')
      .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '商品价格最多保留 2 位小数'),
  }).strict().optional(),
  quantity: deliveryItemQuantitySchema,
}).strict().superRefine((value, context) => {
  if (Boolean(value.productId) === Boolean(value.customProduct)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['productId'], message: 'productId 和 customProduct 必须且只能填一个' })
  }
})

export const deliveryAddItemBodySchema = z.object({
  productId: z.string().trim().min(1).optional(),
  customProduct: z.object({
    name: z.string().trim().min(1, '商品名称必填').max(80, '商品名称不能超过 80 字'),
    unit: z.string().trim().min(1, '商品单位必填').max(16, '商品单位不能超过 16 字')
      .refine(value => !/^\d/.test(value), '单位不能以数字开头'),
    unitPrice: z.coerce.number()
      .nonnegative('商品价格不能为负')
      .max(99_999_999.99, '商品价格超过系统上限')
      .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '商品价格最多保留 2 位小数'),
  }).strict().optional(),
  quantity: deliveryItemQuantitySchema,
  rowVersion: z.coerce.number().int().nonnegative('rowVersion 无效'),
  reason: z.string().trim().max(200, '原因不能超过 200 字').optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.productId) === Boolean(value.customProduct)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['productId'], message: 'productId 和 customProduct 必须且只能填一个' })
  }
})

const deliveryBatchMutationBodySchema = z.object({
  rowVersion: z.coerce.number().int().nonnegative('rowVersion 无效'),
  reason: z.string().trim().max(200, '原因不能超过 200 字').optional(),
  quantityChanges: z.array(z.object({
    itemId: z.string().trim().min(1, 'itemId 必填'),
    targetQuantity: z.coerce.number()
      .nonnegative('调整后数量不能小于 0')
      .max(99_999_999.99, '调整后数量超过系统上限')
      .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '数量最多保留 2 位小数'),
  }).strict()).max(500).default([]),
  removals: z.array(z.object({ itemId: z.string().trim().min(1, 'itemId 必填') }).strict()).max(500).default([]),
  additions: z.array(deliveryAdditionSchema).max(500).default([]),
}).strict().superRefine((value, context) => {
  const operationCount = value.quantityChanges.length + value.removals.length + value.additions.length
  if (operationCount === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '没有需要保存的商品变更' })
  }
  if (operationCount > 500) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '单次最多保存 500 项商品变更' })
  }
  const changedIds = value.quantityChanges.map(item => item.itemId)
  const removedIds = value.removals.map(item => item.itemId)
  if (new Set(changedIds).size !== changedIds.length || new Set(removedIds).size !== removedIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '同一商品不能重复提交' })
  }
  if (removedIds.some(itemId => changedIds.includes(itemId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '移除的商品不能同时修改数量' })
  }
})

async function runSerializableDeliveryMutation<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  timeout: number,
) {
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout,
      })
    } catch (error: any) {
      const retryable = error?.code === 'P2034' || error?.code === 'P2002'
      if (!retryable) throw error
      if (attempt === maxAttempts) {
        throw Object.assign(new Error('商品明细正在同步，请刷新后重试'), { statusCode: 409 })
      }
    }
  }
  throw Object.assign(new Error('商品明细正在同步，请刷新后重试'), { statusCode: 409 })
}

export const deliveryRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { role } = req.user
    if (!allowsSupplyDataRead(role, 'delivery.read')) {
      return reply.status(403).send({ error: '无权查看配送单' })
    }
    const q = parsed.data
    const where = buildDeliveryListWhere(q, req.user)
    const skip = (q.page - 1) * q.pageSize
    const [items, total] = await Promise.all([
      prisma.deliveryOrder.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: q.pageSize,
        include: {
          purchaseOrder: { select: { id: true, no: true, status: true, originalTotalAmount: true, currentOrderAmount: true } },
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          items: { where: { removedAt: null }, include: { product: { select: { id: true, code: true, name: true, unit: true, spec: true } } } },
          receipt: { select: { id: true, no: true, totalAmount: true, status: true } },
        },
      }),
      prisma.deliveryOrder.count({ where }),
    ])
    const profitById = await deliveryProfitById(req.user, items)
    return {
      items: items.map(delivery => attachDeliveryProfit(delivery, profitById)),
      total, page: q.page, pageSize: q.pageSize,
    }
  })

  // 配送单查询导出：复用列表的权限、租户范围与筛选，导出全部匹配行。
  app.get('/export.xlsx', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    if (!allowsSupplyDataRead(req.user.role, 'delivery.read')) {
      return reply.status(403).send({ error: '无权导出配送单' })
    }
    const rows = await prisma.deliveryOrder.findMany({
      where: buildDeliveryListWhere(parsed.data, req.user),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: DELIVERY_EXPORT_MAX_ROWS + 1,
      include: {
        purchaseOrder: { select: { no: true } },
        store: { select: { name: true } },
        supplier: { select: { name: true } },
        items: { where: { removedAt: null }, include: { product: { select: { code: true, name: true, spec: true, unit: true } } } },
      },
    })
    if (exceedsDeliveryExportLimit(rows.length)) {
      return reply.status(422).send({ error: `导出结果超过 ${DELIVERY_EXPORT_MAX_ROWS} 条，请缩小筛选范围` })
    }
    const profitById = await deliveryProfitById(req.user, rows)
    const includeProfit = isInternalSupplyChainRole(req.user.role)
    const statusLabels: Record<string, string> = {
      DRAFT: '草稿', SHIPPED: '已发货', DELIVERED: '已送达', RECEIVED: '已收货', CANCELLED: '已取消',
    }
    const workbook = new ExcelJS.Workbook()
    workbook.creator = '滇界云管'
    const sheet = workbook.addWorksheet('配送单查询')
    sheet.columns = [
      { header: '序号', key: 'sequence', width: 8 },
      { header: '配送单号', key: 'no', width: 24 },
      { header: '关联订货单号', key: 'orderNo', width: 24 },
      { header: '门店', key: 'store', width: 22 },
      { header: '供应商', key: 'supplier', width: 26 },
      { header: '创建时间', key: 'createdAt', width: 22 },
      { header: '发货时间', key: 'shippedAt', width: 22 },
      { header: '状态', key: 'status', width: 14 },
      { header: '商品摘要', key: 'itemSummary', width: 50 },
      { header: '发货金额', key: 'amount', width: 16 },
      ...(includeProfit ? [
        { header: '成本金额', key: 'costAmount', width: 16 },
        { header: '利润', key: 'profit', width: 16 },
      ] : []),
    ]
    rows.forEach((row, index) => {
      const items = row.items.map(withDocumentProductSnapshot)
      const profitability = profitById.get(String(row.id))
      sheet.addRow({
        sequence: index + 1,
        no: row.no,
        orderNo: row.purchaseOrder?.no || '',
        store: row.store?.name || '',
        supplier: row.supplier?.name || '',
        createdAt: formatShanghaiDateTime(row.createdAt),
        shippedAt: formatShanghaiDateTime(row.shippedAt),
        status: statusLabels[row.status] || row.status,
        itemSummary: items.map((item: any) => [item.productNameSnapshot, item.productCodeSnapshot, item.productSpecSnapshot].filter(Boolean).join(' / ')).join('、'),
        amount: includeProfit
          ? (profitability?.shippedAmount == null ? '—' : Number(profitability.shippedAmount))
          : Number(row.actualTotalAmount || 0),
        ...(includeProfit ? {
          costAmount: profitability?.costAmount == null ? '—' : Number(profitability.costAmount),
          profit: profitability?.profit == null ? '—' : Number(profitability.profit),
        } : {}),
      })
    })
    sheet.getRow(1).font = { bold: true }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = { from: 'A1', to: includeProfit ? 'L1' : 'J1' }
    sheet.getColumn('amount').numFmt = '#,##0.00'
    if (includeProfit) {
      sheet.getColumn('costAmount').numFmt = '#,##0.00'
      sheet.getColumn('profit').numFmt = '#,##0.00'
    }
    const filename = `配送单查询-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.xlsx`
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(buffer)
  })

  app.get('/:id/export.xlsx', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!isInternalSupplyChainRole(req.user.role)) {
      return reply.status(403).send({ error: '只有内部供应链可导出配送成本利润明细' })
    }
    const delivery = await prisma.deliveryOrder.findFirst({
      where: { id: String(req.params.id), ...supplyDataReadScope(req.user), ...publicDeliveryMarkerFilter() },
      include: {
        purchaseOrder: { select: { no: true } },
        store: { select: { name: true } },
        supplier: { select: { name: true } },
        items: { where: { removedAt: null }, include: { product: true } },
      },
    })
    if (!delivery) return reply.status(404).send({ error: '配送单不存在' })
    const profitById = await deliveryProfitById(req.user, [delivery])
    const projected = attachDeliveryProfit(delivery, profitById)
    const workbook = new ExcelJS.Workbook()
    workbook.creator = '滇界云管'
    const sheet = workbook.addWorksheet('配送成本利润明细')
    sheet.columns = [
      { header: '序号', key: 'sequence', width: 8 },
      { header: '配送单号', key: 'deliveryNo', width: 24 },
      { header: '关联订货单号', key: 'orderNo', width: 24 },
      { header: '门店', key: 'store', width: 22 },
      { header: '供应商', key: 'supplier', width: 26 },
      { header: '物品编码', key: 'productCode', width: 18 },
      { header: '物品名称', key: 'productName', width: 24 },
      { header: '规格型号', key: 'productSpec', width: 18 },
      { header: '单位', key: 'unit', width: 12 },
      { header: '接单数量', key: 'acceptedQuantity', width: 14 },
      { header: '发货数量', key: 'shippedQuantity', width: 14 },
      { header: '发货单价', key: 'unitPrice', width: 14 },
      { header: '发货金额', key: 'shippedAmount', width: 14 },
      { header: '净结算金额', key: 'settlementAmount', width: 18 },
      { header: '成本单价', key: 'costUnitPrice', width: 14 },
      { header: '成本金额', key: 'costAmount', width: 14 },
      { header: '利润', key: 'profit', width: 14 },
    ]
    projected.items.forEach((item: any, index: number) => {
      const p = item.profitability
      sheet.addRow({
        sequence: index + 1,
        deliveryNo: delivery.no,
        orderNo: delivery.purchaseOrder.no,
        store: delivery.store.name,
        supplier: delivery.supplier.name,
        productCode: item.productCodeSnapshot || item.product?.code || '',
        productName: item.productNameSnapshot || item.product?.name || '',
        productSpec: item.productSpecSnapshot || item.product?.spec || '',
        unit: item.productUnitSnapshot || item.product?.unit || '',
        acceptedQuantity: p?.acceptedQuantity == null ? '—' : Number(p.acceptedQuantity),
        shippedQuantity: p?.shippedQuantity == null ? '—' : Number(p.shippedQuantity),
        unitPrice: p?.unitPrice == null ? '—' : Number(p.unitPrice),
        shippedAmount: p?.shippedAmount == null ? '—' : Number(p.shippedAmount),
        settlementAmount: p?.settlementAmount == null ? '—' : Number(p.settlementAmount),
        costUnitPrice: p?.costUnitPrice == null ? '—' : Number(p.costUnitPrice),
        costAmount: p?.costAmount == null ? '—' : Number(p.costAmount),
        profit: p?.profit == null ? '—' : Number(p.profit),
      })
    })
    sheet.getRow(1).font = { bold: true }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = { from: 'A1', to: 'Q1' }
    for (const key of ['unitPrice', 'shippedAmount', 'settlementAmount', 'costUnitPrice', 'costAmount', 'profit']) {
      sheet.getColumn(key).numFmt = '#,##0.00'
    }
    const filename = `配送成本利润明细-${delivery.no}.xlsx`
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(buffer)
  })

  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { role, supplierId } = req.user
    if (!allowsSupplyDataRead(role, 'delivery.read')) {
      throw { statusCode: 403, message: '无权查看配送单' }
    }
    const where: any = {
      id: req.params.id,
      ...supplyDataReadScope(req.user),
      ...publicDeliveryMarkerFilter(),
    }
    if (isSupplierRole(role)) where.supplierId = requireSupplierCapability(role, supplierId, 'order.read')
    const delivery = await prisma.deliveryOrder.findFirst({
      where,
      include: {
        purchaseOrder: { include: { items: { where: { isActive: true }, include: { product: true } } } },
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true, role: true } },
        shippedBy: { select: { id: true, name: true } },
        deliveredBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        items: { where: { removedAt: null }, include: { product: true } },
        events: { orderBy: { occurredAt: 'asc' }, include: { actor: { select: { id: true, name: true, role: true } } } },
        receipt: { include: { items: { include: { product: true } } } },
      },
    })
    if (!delivery) throw { statusCode: 404, message: '配送单不存在' }
    const profitById = await deliveryProfitById(req.user, [delivery])
    return {
      ...attachDeliveryProfit(delivery, profitById),
      receipt: delivery.receipt ? {
        ...delivery.receipt,
        items: delivery.receipt.items.map(withDocumentProductSnapshot),
      } : null,
    }
  })

  const resolveInternalDeliverySupplier = async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!hasInternalSupplyChainCapability(role, 'delivery.write')) {
      reply.status(403).send({ error: '仅内部供应链可调整配送商品' })
      return null
    }
    const scopedDelivery = await prisma.deliveryOrder.findFirst({
      where: {
        id: String(req.params.id),
        tenantId,
        ...publicDeliveryMarkerFilter(),
      },
      select: { supplierId: true },
    })
    if (!scopedDelivery) {
      reply.status(404).send({ error: '配送单不存在' })
      return null
    }
    return scopedDelivery.supplierId
  }

  // 商品明细页的唯一保存入口：数量、新增和移除在同一个串行化事务中完成。
  app.patch('/:id/items', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const scopedSupplierId = await resolveInternalDeliverySupplier(req, reply)
    if (!scopedSupplierId) return
    const parsed = deliveryBatchMutationBodySchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    try {
      return await runSerializableDeliveryMutation(async tx => {
        let rowVersion = parsed.data.rowVersion
        let lastResult: any = null
        const common = {
          tenantId,
          supplierId: scopedSupplierId,
          deliveryOrderId: String(req.params.id),
          userId,
          userRole: role,
          reason: parsed.data.reason,
          requestId: req.id,
          ip: req.ip,
        }
        for (const change of parsed.data.quantityChanges) {
          lastResult = await changeDeliveryItemQuantityInTransaction(tx, {
            ...common,
            itemId: change.itemId,
            targetQuantity: new Prisma.Decimal(change.targetQuantity),
            rowVersion,
          })
          rowVersion = lastResult.rowVersion
        }
        for (const addition of parsed.data.additions) {
          lastResult = await addDeliveryItemInTransaction(tx, {
            ...common,
            productId: addition.productId,
            customProduct: addition.customProduct ? {
              name: addition.customProduct.name,
              unit: addition.customProduct.unit,
              unitPrice: new Prisma.Decimal(addition.customProduct.unitPrice),
            } : null,
            quantity: new Prisma.Decimal(addition.quantity),
            rowVersion,
          })
          rowVersion = lastResult.rowVersion
        }
        for (const removal of parsed.data.removals) {
          lastResult = await removeDeliveryItemInTransaction(tx, {
            ...common,
            itemId: removal.itemId,
            rowVersion,
          })
          rowVersion = lastResult.rowVersion
        }
        return {
          success: true,
          rowVersion,
          deliveryTotal: lastResult?.deliveryTotal,
          orderTotal: lastResult?.orderTotal,
          changedCount: parsed.data.quantityChanges.length,
          addedCount: parsed.data.additions.length,
          removedCount: parsed.data.removals.length,
        }
      }, 60_000)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.patch('/:id/item-quantity', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const scopedSupplierId = await resolveInternalDeliverySupplier(req, reply)
    if (!scopedSupplierId) return
    const parsed = z.object({
      itemId: z.string().trim().min(1, 'itemId 必填'),
      targetQuantity: z.coerce.number()
        .nonnegative('调整后数量不能小于 0')
        .max(99_999_999.99, '调整后数量超过系统上限')
        .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '数量最多保留 2 位小数'),
      rowVersion: z.coerce.number().int().nonnegative('rowVersion 无效'),
      reason: z.string().trim().max(200, '原因不能超过 200 字').optional(),
    }).safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      return await runSerializableDeliveryMutation(tx => changeDeliveryItemQuantityInTransaction(tx, {
        tenantId,
        supplierId: scopedSupplierId,
        deliveryOrderId: String(req.params.id),
        itemId: parsed.data.itemId,
        targetQuantity: new Prisma.Decimal(parsed.data.targetQuantity),
        userId,
        userRole: role,
        rowVersion: parsed.data.rowVersion,
        reason: parsed.data.reason,
        requestId: req.id,
        ip: req.ip,
      }), 30_000)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.post('/:id/add-item', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const scopedSupplierId = await resolveInternalDeliverySupplier(req, reply)
    if (!scopedSupplierId) return
    const parsed = deliveryAddItemBodySchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      return await runSerializableDeliveryMutation(tx => addDeliveryItemInTransaction(tx, {
        tenantId,
        supplierId: scopedSupplierId,
        deliveryOrderId: String(req.params.id),
        productId: parsed.data.productId,
        customProduct: parsed.data.customProduct ? {
          name: parsed.data.customProduct.name,
          unit: parsed.data.customProduct.unit,
          unitPrice: new Prisma.Decimal(parsed.data.customProduct.unitPrice),
        } : null,
        quantity: new Prisma.Decimal(parsed.data.quantity),
        userId,
        userRole: role,
        rowVersion: parsed.data.rowVersion,
        reason: parsed.data.reason,
        requestId: req.id,
        ip: req.ip,
      }), 30_000)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  // 仅内部供应链可在门店确认收货前移除配送中的单个商品。
  // 这是软移除：保留原明细和审计流水，库存/订单金额在同一事务冲回。
  app.patch('/:id/remove-item', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const scopedSupplierId = await resolveInternalDeliverySupplier(req, reply)
    if (!scopedSupplierId) return
    const parsed = z.object({
      itemId: z.string().trim().min(1, 'itemId 必填'),
      rowVersion: z.coerce.number().int().nonnegative('rowVersion 无效'),
      reason: z.string().trim().max(200, '原因不能超过 200 字').optional(),
    }).safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    try {
      return await runSerializableDeliveryMutation(tx => removeDeliveryItemInTransaction(tx, {
        tenantId,
        supplierId: scopedSupplierId,
        deliveryOrderId: String(req.params.id),
        itemId: parsed.data.itemId,
        userId,
        userRole: role,
        rowVersion: parsed.data.rowVersion,
        reason: parsed.data.reason,
        requestId: req.id,
        ip: req.ip,
      }), 20_000)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })
}
