import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma, prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { invalidatePattern } from '../lib/cache'
import { notifyOrderSubmitted, notifyOrderShipped, notifyOrderConfirmed, notifyOrderRejected, sendNotification } from '../services/notification'
import { isStoreScoped, isSupplierRole, requireSupplierBinding } from '../lib/auth-scope'
import { resignOssUrls } from './upload'
import { fireAndForget as notify } from '../services/notify'
import {
  businessNoFloor,
  buildOrderSnapshot,
  diffOrderSnapshots,
  lineAmount,
  nextBusinessNo,
  revisionType,
  snapshotHash,
  sumOrderAmount,
  type OrderSnapshot,
} from '../services/purchaseOrderIntegrity'
import {
  consumeSupplierStockForShipment,
  releaseSupplierStockForOrder,
  reserveSupplierStockForOrder,
} from '../services/supplierStockReservation'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'
import { calendarDateSchema } from '../lib/calendar-date'
import { ensureReceiptInventoryUnitSnapshots } from '../services/receiptInventoryUnits'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'

// CLAUDE.md 约定：所有写入用 zod 校验
const PURCHASE_QUANTITY_MAX = 99_999_999.99
const PURCHASE_AMOUNT_MAX = new Prisma.Decimal('9999999999.99')

function orderAmountBoundError(lineAmounts: Prisma.Decimal[], total: Prisma.Decimal): string | null {
  if (lineAmounts.some(amount => amount.gt(PURCHASE_AMOUNT_MAX))) return '单行金额超过系统上限'
  if (total.gt(PURCHASE_AMOUNT_MAX)) return '订货单总金额超过系统上限'
  return null
}

const orderItemSchema = z.object({
  productId: z.string().min(1, 'productId 必填'),
  quantity:  z.number().positive('quantity 必须 > 0').max(PURCHASE_QUANTITY_MAX, '订货数量超过系统上限'),
  unitPrice: z.number().nonnegative('unitPrice 不能为负'),
})
const orderCreateSchema = z.object({
  storeId:      z.string().optional(),
  supplierId:   z.string().min(1, 'supplierId 必填'),
  expectedDate: calendarDateSchema,
  note:         z.string().optional().default(''),
  items:        z.array(orderItemSchema).min(1, '至少一条采购明细').max(500, '单次最多 500 条采购明细'),
  // 防重复提交: 客户端 uuid, 后端缓存 60s 拦截重复 POST
  idempotencyKey: z.string().max(80).optional(),
})

const revisionCreateSchema = z.object({
  reason: z.string().trim().min(2, '请填写改单原因').max(200),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().positive('订货数量必须大于 0').max(PURCHASE_QUANTITY_MAX, '订货数量超过系统上限'),
  }).strict()).min(1, '订货单至少保留一个商品').max(500).optional(),
  expectedDate: calendarDateSchema.optional(),
  note: z.string().max(500).nullable().optional(),
  baseRowVersion: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(8).max(80).optional(),
}).strict()

const revisionReviewSchema = z.object({
  note: z.string().trim().max(200).optional(),
}).strict()

const deliveryShipSchema = z.object({
  note: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
  items: z.array(z.object({
    itemId: z.string().min(1),
    shippedQty: z.number().nonnegative().max(PURCHASE_QUANTITY_MAX, '实发数量超过系统上限'),
  }).strict()).max(500).optional(),
}).strict()

const deliveryDeliverSchema = z.object({
  note: z.string().trim().max(500, '送达备注最长 500 字').optional(),
}).strict()

const chefAckSchema = z.object({
  images: z.array(z.string().trim().min(1, '验收照片地址不能为空')).min(1, '请至少上传 1 张验收照片').max(5, '验收单最多 5 张照片'),
  note: z.string().max(500, '备注最长 500 字').optional(),
}).strict()

const deliveryReceiveSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1, 'productId 必填'),
    receivedQty: z.number().nonnegative('实收数量不能为负').max(PURCHASE_QUANTITY_MAX, '实收数量超过系统上限'),
  }).strict()).max(500, '单次最多 500 条收货明细').optional(),
  evidenceImages: z.array(z.string().min(1, '证据图片地址不能为空')).max(9, '证据图片最多 9 张').optional(),
  reason: z.string().optional(),
  kind: z.enum(['ARRIVAL_SHORTAGE', 'ARRIVAL_DAMAGE']).optional(),
}).strict()

const orderListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED', 'CANCELLED']).optional(),
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

class ReceiptAlreadyProcessedError extends Error {
  constructor() {
    super('delivery receipt already processed')
    this.name = 'ReceiptAlreadyProcessedError'
  }
}

// 内存级幂等缓存 (60s TTL) — 防止厨师长双击 / 网络重试创双单
const idempotencyCache = new Map<string, { orderId: string; orderNo: string; expiresAt: number }>()
function getIdempotent(key: string) {
  const v = idempotencyCache.get(key)
  if (!v) return null
  if (v.expiresAt < Date.now()) { idempotencyCache.delete(key); return null }
  return v
}
function setIdempotent(key: string, orderId: string, orderNo: string) {
  idempotencyCache.set(key, { orderId, orderNo, expiresAt: Date.now() + 60_000 })
}

export const purchaseOrderRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = orderListQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const q = parsed.data
    const where: any = { tenantId }

    const scopedSupplierId = requireSupplierBinding(role, userSupplierId)

    // 门店级角色（店长/总厨/采购）只看自己门店
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    // 供应商只看发给自己的
    if (scopedSupplierId) where.supplierId = scopedSupplierId

    if (q.status) where.status = q.status
    if (q.storeId && !isStoreScoped(role)) where.storeId = q.storeId
    if (q.supplierId && !isSupplierRole(role)) where.supplierId = q.supplierId
    const and: any[] = []
    if (q.productId) and.push({ items: { some: { productId: q.productId, isActive: true } } })
    if (q.keyword) {
      and.push({
        OR: [
          { no: { contains: q.keyword, mode: 'insensitive' } },
          { store: { name: { contains: q.keyword, mode: 'insensitive' } } },
          {
            items: {
              some: {
                isActive: true,
                product: {
                  OR: [
                    { name: { contains: q.keyword, mode: 'insensitive' } },
                    { code: { contains: q.keyword, mode: 'insensitive' } },
                    { spec: { contains: q.keyword, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        ],
      })
    }
    if (and.length) where.AND = and
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00+08:00`) } : {}),
        ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59.999+08:00`) } : {}),
      }
    }

    const p = q.page
    const ps = q.pageSize
    const skip = (p - 1) * ps

    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip, take: ps,
        include: {
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true, role: true } },
          items: { where: { isActive: true }, include: { product: { select: { name: true, unit: true, spec: true, code: true } } } },
          lossClaims: { select: { id: true, status: true, totalLossAmount: true } },
          deliveries: {
            where: { status: { not: 'CANCELLED' } },
            select: { id: true, status: true, actualTotalAmount: true },
          },
          receipts: { select: { id: true, totalAmount: true, status: true } },
        },
      }),
      prisma.purchaseOrder.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────
  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const { id } = req.params as any
    // 按角色 scope 过滤，避免店长/供应商越权读到别家单据
    const where: any = { id, tenantId }
    const scopedSupplierId = requireSupplierBinding(role, userSupplierId)
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    if (scopedSupplierId) where.supplierId = scopedSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where,
      include: {
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true, role: true } },
        shippedBy: { select: { id: true, name: true } },
        items: { include: { product: true } },
        revisions: {
          orderBy: { revisionNo: 'asc' },
          include: {
            requestedBy: { select: { id: true, name: true, role: true } },
            reviewedBy: { select: { id: true, name: true, role: true } },
          },
        },
        events: {
          orderBy: { occurredAt: 'asc' },
          include: { actor: { select: { id: true, name: true, role: true } } },
        },
        deliveries: {
          orderBy: { createdAt: 'asc' },
          include: {
            items: { include: { product: true } },
            receipt: { select: { id: true, no: true, totalAmount: true, status: true } },
          },
        },
        lossClaims: {
          include: {
            deliveryOrder: { select: { id: true, no: true } },
            receipt: { select: { id: true, no: true } },
            items: { include: { product: true } },
          },
        },
        receipt: true,
        receipts: { orderBy: { deliveryDate: 'asc' } },
      },
    })
    if (!order) throw { statusCode: 404, message: '采购订单不存在' }
    if (Array.isArray((order as any).deliveries)) {
      ;(order as any).deliveries = (order as any).deliveries.map((delivery: any) => ({
        ...delivery,
        items: Array.isArray(delivery.items) ? delivery.items.map(withDocumentProductSnapshot) : [],
      }))
    }
    // OSS 签名 1h 过期 → 读取时把所有 OSS URL 字段统一重签
    if (Array.isArray((order as any).lossClaims)) {
      ;(order as any).lossClaims = (order as any).lossClaims.map((c: any) => ({
        ...c,
        items: Array.isArray(c.items) ? c.items.map(withDocumentProductSnapshot) : [],
        evidenceImages: resignOssUrls(c.evidenceImages),
      }))
    }
    // 厨师验收单照片 (2026-05-31 客户反馈: 不重签 1h 后碎图)
    if (Array.isArray((order as any).chefAckImages)) {
      ;(order as any).chefAckImages = resignOssUrls((order as any).chefAckImages)
    }
    // 收货人 = 门店指定 consigneeId(一般厨师长)的姓名+电话; 未指定则回退店长 managerName/phone
    // consigneeId 用 raw 查 (避免改 Prisma client). 供应商送货单显示此人, 方便联系实际收货的人
    try {
      const cg = await prisma.$queryRaw<{ name: string | null; phone: string | null }[]>`
        SELECT COALESCE(u.name, s."managerName") AS name, COALESCE(u.phone, s.phone) AS phone
        FROM stores s LEFT JOIN users u ON u.id = s."consigneeId"
        WHERE s.id = ${(order as any).storeId}
      `
      ;(order as any).consignee = cg[0] || { name: (order as any).store?.managerName ?? null, phone: (order as any).store?.phone ?? null }
    } catch {
      ;(order as any).consignee = { name: (order as any).store?.managerName ?? null, phone: (order as any).store?.phone ?? null }
    }
    const allItems = (order as any).items || []
    const original = ((order as any).submittedSnapshot || buildOrderSnapshot(order as any, 'original')) as OrderSnapshot
    const current = buildOrderSnapshot(order as any, 'current')
    return {
      ...order,
      items: allItems.filter((item: any) => item.isActive !== false),
      original,
      current,
      timeline: (order as any).events || [],
      totals: {
        ordered: String((order as any).originalTotalAmount ?? original.totalAmount),
        current: String((order as any).currentOrderAmount ?? current.totalAmount),
        legacy: String(order.totalAmount),
      },
    }
  })

  // ── 创建（店长）──────────────────────────────────
  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = orderCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    const { tenantId, userId, storeId: userStoreId, role } = req.user
    const { storeId, supplierId, expectedDate, note, items, idempotencyKey } = parsed.data

    // 角色白名单 — 防止供应商/财务等错误调用
    const ALLOWED_CREATE_ROLES = ['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN']
    if (!ALLOWED_CREATE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '无权创建采购订单' })
    }

    // 快速防重复: 内存缓存只作为性能优化；数据库唯一键才是最终幂等保障。
    if (idempotencyKey) {
      const cacheKey = `${tenantId}:${userId}:${idempotencyKey}`
      const cached = getIdempotent(cacheKey)
      if (cached) {
        const dup = await prisma.purchaseOrder.findUnique({
          where: { id: cached.orderId },
          include: { store: true, supplier: true, items: { where: { isActive: true }, include: { product: true } } },
        })
        if (dup) return dup    // 静默返回首单, 不报错
      }
      const persisted = await prisma.purchaseOrder.findFirst({
        where: { tenantId, createdById: userId, idempotencyKey },
        include: { store: true, supplier: true, items: { where: { isActive: true }, include: { product: true } } },
      })
      if (persisted) return persisted
    }

    // 单店级角色 (店长/厨师长/...) 强制用 token 里的 storeId, 防止跨店越权
    // 集团级 (BOSS/FINANCE) 才允许传 storeId 指定门店
    const finalStoreId = isStoreScoped(role) ? userStoreId : storeId
    if (!finalStoreId) return reply.status(400).send({ error: '请指定门店 (storeId)' })

    // 起订量 / 步长 校验 — 防止厨师长漏看 picker 提示直接 POST
    const productIds = items.map((i: any) => i.productId)
    if (new Set(productIds).size !== productIds.length) {
      return reply.status(400).send({ error: '同一商品不能重复提交多行' })
    }
    const productsMoq = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId, supplierId, status: 'ENABLED' },
      select: { id: true, name: true, unit: true, minOrderQty: true, stepQty: true, price: true },
    })
    if (productsMoq.length !== productIds.length) {
      return reply.status(400).send({ error: '存在无效、已停售或不属于该供应商的商品' })
    }
    const moqMap = new Map(productsMoq.map(p => [p.id, p]))
    for (const i of items) {
      const p = moqMap.get(i.productId)
      if (!p) continue
      const moq = Number(p.minOrderQty || 1)
      const step = Number(p.stepQty || 1)
      const q = Number(i.quantity)
      if (q < moq - 0.0001) {
        return reply.status(400).send({ error: `${p.name} 起订量为 ${moq} ${p.unit}, 当前 ${q}` })
      }
      // 浮点容差 1e-4
      if (step > 0 && Math.abs(((q - moq) / step) - Math.round((q - moq) / step)) > 0.0001) {
        return reply.status(400).send({ error: `${p.name} 需以 ${step} ${p.unit} 为步长 (起 ${moq})` })
      }
    }

    // P1: 单价以 DB Product.price 为权威, 忽略客户端传的 unitPrice
    // 防内部串通低报单价 / 客户端 bug
    const priceMap = new Map(productsMoq.map(p => [p.id, p.price]))
    const itemsData = items.map((i: any) => {
      const dbPrice = priceMap.get(i.productId)
      if (dbPrice === undefined) {
        throw { statusCode: 400, message: `商品不存在: ${i.productId}` }
      }
      const amount = lineAmount(i.quantity, dbPrice)
      return {
        productId: i.productId,
        quantity: i.quantity,
        originalQuantity: i.quantity,
        unitPrice: dbPrice,
        originalUnitPrice: dbPrice,
        amount,
        originalAmount: amount,
        lineOrigin: 'ORIGINAL' as const,
      }
    })
    const totalAmount = sumOrderAmount(itemsData)
    const amountError = orderAmountBoundError(itemsData.map(item => item.amount), totalAmount)
    if (amountError) return reply.status(400).send({ error: amountError })
    const submittedAt = new Date()
    const ym = dayjs().format('YYYYMM')

    let order: any
    try {
      order = await prisma.$transaction(async (tx) => {
        // A new sequence table can be empty while historical orders already exist.
        // Correct it from the largest current-period order number before incrementing.
        const latestOrder = await tx.purchaseOrder.findFirst({
          where: { tenantId, no: { startsWith: `PO${ym}` } },
          orderBy: { no: 'desc' },
          select: { no: true },
        })
        const no = await nextBusinessNo(
          tx,
          tenantId,
          'PO',
          ym,
          'PO',
          businessNoFloor(latestOrder?.no, 'PO', ym),
        )
        const created = await tx.purchaseOrder.create({
          data: {
            tenantId, no, storeId: finalStoreId, supplierId,
            expectedDate: new Date(expectedDate),
            totalAmount,
            originalTotalAmount: totalAmount,
            currentOrderAmount: totalAmount,
            note, createdById: userId,
            submittedAt,
            idempotencyKey: idempotencyKey || null,
            status: 'SUBMITTED',
            items: { create: itemsData },
          },
          include: {
            store: true,
            supplier: true,
            createdBy: { select: { id: true, name: true, role: true } },
            items: { include: { product: true } },
          },
        })
        const original = buildOrderSnapshot(created as any, 'original')
        const hash = snapshotHash(original)
        await tx.purchaseOrder.update({
          where: { id: created.id },
          data: { submittedSnapshot: original as any, submittedSnapshotHash: hash },
        })
        await tx.purchaseOrderEvent.createMany({
          data: [
            {
              tenantId, purchaseOrderId: created.id, eventType: 'CREATED',
              actorId: userId, actorRole: role, toStatus: 'SUBMITTED', requestId: req.id, ip: req.ip,
              metadata: { no, orderedTotalAmount: totalAmount.toFixed(2) },
            },
            {
              tenantId, purchaseOrderId: created.id, eventType: 'SUBMITTED',
              actorId: userId, actorRole: role, toStatus: 'SUBMITTED', requestId: req.id, ip: req.ip,
              metadata: { snapshotHash: hash },
            },
          ],
        })
        return { ...created, submittedSnapshot: original, submittedSnapshotHash: hash }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error: any) {
      if (error?.code === 'P2002' && idempotencyKey) {
        const existing = await prisma.purchaseOrder.findFirst({
          where: { tenantId, createdById: userId, idempotencyKey },
          include: { store: true, supplier: true, items: { where: { isActive: true }, include: { product: true } } },
        })
        if (existing) return existing
      }
      throw error
    }

    const actionPrefix = role === 'CHEF_DIRECTOR' ? `总厨代 ${order.store.name} 下单` : `创建采购订单`
    await prisma.opLog.create({ data: { tenantId, userId, action: `${actionPrefix} ${order.no}`, target: order.no, entityType: 'PurchaseOrder', targetId: order.id } })
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    void notifyOrderSubmitted(tenantId, order.no, order.store.name, supplierId)
    // M2 新通道层: 同步发企微卡片 (旧 notifyOrderSubmitted 写 DB 通知, 保留双轨)
    notify({
      tenantId, event: 'PO_SUBMITTED',
      eventKey: `PO:${order.id}:SUBMITTED`,
      payload: {
        orderId: order.id, no: order.no, storeName: order.store.name,
        itemCount: order.items.length, total: Number(order.originalTotalAmount ?? order.totalAmount),
      },
      toSupplierIds: [supplierId],
    })
    if (idempotencyKey) setIdempotent(`${tenantId}:${userId}:${idempotencyKey}`, order.id, order.no)
    return order
  })

  // ── 取消订单 (下单方主动撤回, 仅 SUBMITTED 状态可取消, 供应商接单后只能让供应商拒) ────
  app.patch('/:id/cancel', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    const { reason } = (req.body || {}) as any
    const cancelReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : ''
    if (!cancelReason) return reply.status(400).send({ error: '请填写撤回原因' })
    // 仅下单方角色可取消 (店长/厨师长/老板/超管/采购/总厨代下)
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权撤回订单' })
    }
    // 2026-05-29 客户反馈: 撤回窗口放宽到"供应商发货前" (SUBMITTED 待接单 + CONFIRMED 已接单待发货)
    // DELIVERING 起就是已发货, 货已经在路上, 不让撤; 该报损/拒收走原流程
    const where: any = { id, tenantId, status: { in: ['SUBMITTED', 'CONFIRMED'] } as any }
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    // 总厨只能撤自己下的单 (代下), 不能撤厨师长/店长下的单
    if (role === 'CHEF_DIRECTOR') where.createdById = userId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 供应商已发货 / 状态不可撤回' })

    const wasConfirmed = order.status === 'CONFIRMED'
    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrder.updateMany({
        where: { id, status: order.status, rowVersion: order.rowVersion },
        data: {
          status: 'CANCELLED', cancelReason, cancelledAt: new Date(), cancelledById: userId,
          rowVersion: { increment: 1 },
        },
      })
      if (updated.count === 0) throw { statusCode: 409, message: '订单状态已变化，请刷新后重试' }
      if (wasConfirmed) await releaseSupplierStockForOrder(tx, id)
      await tx.purchaseOrderEvent.create({
        data: {
          tenantId, purchaseOrderId: id, eventType: 'CANCELLED', actorId: userId, actorRole: role,
          fromStatus: order.status, toStatus: 'CANCELLED', requestId: req.id, ip: req.ip,
          metadata: { reason: cancelReason, acceptedBeforeCancel: wasConfirmed },
        },
      })
      await tx.opLog.create({
        data: { tenantId, userId, action: `下单方撤回订单 (原状态: ${order.status}): ${cancelReason.slice(0,80)}`, target: order.no, entityType: 'PurchaseOrder', targetId: id },
      })
    })
    // 通知供应商 (避免他正在准备发货)
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void sendNotification({
      tenantId, recipientRole: 'SUPPLIER_STAFF',
      type: 'ORDER_CANCELLED' as any,
      title: `订单撤回 ${order.no}${wasConfirmed ? ' (已接单, 请停止备货)' : ''}`,
      body: `${sup?.name || ''} 的订单 ${order.no} 已被下单方撤回${wasConfirmed ? ' — 该单你已接单, 请立即停止备货发货' : ''}: ${cancelReason.slice(0,40)}`,
      refType: 'PurchaseOrder', refId: id,
    })
    return { success: true }
  })

  // ── 订货单修订申请: 供应商只能提议, 必须由门店确认后才能接单 ─────────────
  app.post('/:id/revisions', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = revisionCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, userId, role, supplierId: actorSupplierId, storeId: actorStoreId } = req.user
    const { id } = req.params as any
    const input = parsed.data
    const requesterAllowed = isSupplierRole(role) || ['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)
    if (!requesterAllowed) return reply.status(403).send({ error: '无权申请修改订货单' })

    const order = await prisma.purchaseOrder.findFirst({
      where: { id, tenantId, status: 'SUBMITTED' },
      include: {
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true, role: true } },
        items: { include: { product: true } },
      },
    })
    if (!order) return reply.status(400).send({ error: '订单不存在或已接单，当前不可修改' })
    if (isSupplierRole(role) && order.supplierId !== actorSupplierId) return reply.status(404).send({ error: '订单不存在' })
    if (isStoreScoped(role) && order.storeId !== actorStoreId) return reply.status(404).send({ error: '订单不存在' })
    if (role === 'CHEF_DIRECTOR' && order.createdById !== userId) return reply.status(403).send({ error: '只能修改自己代下的订单' })
    if (input.baseRowVersion !== order.rowVersion) return reply.status(409).send({ error: '订单已更新，请刷新后重新提交' })
    if (isSupplierRole(role) && (input.expectedDate !== undefined || input.note !== undefined)) {
      return reply.status(400).send({ error: '供应商只能申请调整商品或数量' })
    }

    if (input.requestKey) {
      const duplicate = await prisma.purchaseOrderRevision.findFirst({
        where: { purchaseOrderId: id, requestKey: input.requestKey },
        include: { requestedBy: { select: { id: true, name: true, role: true } } },
      })
      if (duplicate) return duplicate
    }

    const before = buildOrderSnapshot(order as any, 'current')
    const requestedItems = input.items ?? before.items.map(item => ({ productId: item.productId, quantity: Number(item.quantity) }))
    if (new Set(requestedItems.map(item => item.productId)).size !== requestedItems.length) {
      return reply.status(400).send({ error: '同一商品不能重复提交多行' })
    }
    const productIds = requestedItems.map(item => item.productId)
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId, supplierId: order.supplierId },
      select: { id: true, code: true, name: true, spec: true, unit: true, price: true, status: true, minOrderQty: true, stepQty: true },
    })
    if (products.length !== productIds.length) return reply.status(400).send({ error: '存在不属于该供应商的商品' })
    const productMap = new Map(products.map(product => [product.id, product]))
    const beforeMap = new Map(before.items.map(item => [item.productId, item]))
    const afterItems = requestedItems.map(item => {
      const product = productMap.get(item.productId)!
      const previous = beforeMap.get(item.productId)
      if (!previous && product.status !== 'ENABLED') throw { statusCode: 400, message: `${product.name} 已停售，不能追加` }
      const moq = Number(product.minOrderQty || 1)
      const step = Number(product.stepQty || 1)
      if (item.quantity < moq - 0.0001) throw { statusCode: 400, message: `${product.name} 起订量为 ${moq} ${product.unit}` }
      if (step > 0 && Math.abs(((item.quantity - moq) / step) - Math.round((item.quantity - moq) / step)) > 0.0001) {
        throw { statusCode: 400, message: `${product.name} 需以 ${step} ${product.unit} 为步长` }
      }
      const unitPrice = previous?.unitPrice ?? new Prisma.Decimal(product.price).toFixed(2)
      return {
        lineId: previous?.lineId ?? `revision:${item.productId}`,
        productId: item.productId,
        code: product.code,
        name: product.name,
        spec: product.spec,
        unit: product.unit,
        quantity: new Prisma.Decimal(item.quantity).toFixed(2),
        unitPrice,
        amount: lineAmount(item.quantity, unitPrice).toFixed(2),
        lineOrigin: previous?.lineOrigin ?? 'APPROVED_REVISION' as const,
      }
    }).sort((a, b) => a.productId.localeCompare(b.productId))
    const afterTotal = afterItems.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0)).toDecimalPlaces(2)
    const amountError = orderAmountBoundError(afterItems.map(item => new Prisma.Decimal(item.amount)), afterTotal)
    if (amountError) return reply.status(400).send({ error: amountError })
    const after: OrderSnapshot = {
      ...before,
      expectedDate: input.expectedDate ?? before.expectedDate,
      note: input.note !== undefined ? input.note : before.note,
      items: afterItems,
      totalAmount: afterTotal.toFixed(2),
      revisionNo: before.revisionNo + 1,
    }
    const changes = diffOrderSnapshots(before, after)
    if (changes.length === 0) return reply.status(400).send({ error: '没有检测到任何修改' })

    try {
      const revision = await prisma.$transaction(async (tx) => {
        const pending = await tx.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: id, status: 'PENDING' } })
        if (pending) throw { statusCode: 409, message: '该订单已有待门店确认的修改' }
        const maxRevision = await tx.purchaseOrderRevision.aggregate({ where: { purchaseOrderId: id }, _max: { revisionNo: true } })
        const revisionNo = (maxRevision._max.revisionNo ?? 0) + 1
        after.revisionNo = revisionNo
        const created = await tx.purchaseOrderRevision.create({
          data: {
            tenantId, purchaseOrderId: id, revisionNo, type: revisionType(changes), reason: input.reason,
            beforeSnapshot: before as any, afterSnapshot: after as any, changeSet: changes as any,
            requestKey: input.requestKey || null, baseRowVersion: order.rowVersion, requestedById: userId,
          },
          include: { requestedBy: { select: { id: true, name: true, role: true } } },
        })
        await tx.purchaseOrderEvent.create({
          data: {
            tenantId, purchaseOrderId: id, eventType: 'REVISION_REQUESTED', actorId: userId, actorRole: role,
            fromStatus: order.status, toStatus: order.status, requestId: req.id, ip: req.ip,
            metadata: { revisionId: created.id, revisionNo, reason: input.reason, changes },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, action: `申请修改订货单 ${order.no} (第 ${revisionNo} 次): ${input.reason}`,
            target: order.no, entityType: 'PurchaseOrderRevision', targetId: created.id,
            metadata: { changes },
          },
        })
        return created
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      const storeRecipients = await prisma.user.findMany({
        where: {
          tenantId, status: 'ACTIVE', role: { in: ['MANAGER', 'KITCHEN_LEAD'] },
          OR: [{ storeId: order.storeId }, { storeIds: { has: order.storeId } }],
        },
        select: { id: true, role: true },
      })
      for (const recipient of storeRecipients) {
        void sendNotification({
          tenantId, recipientRole: recipient.role, recipientId: recipient.id,
          type: 'ORDER_REVISION_PENDING' as any,
          title: `订货单改单待确认 ${order.no}`,
          body: `${order.supplier.name} 申请调整 ${changes.length} 项，原因: ${input.reason}`,
          refType: 'PurchaseOrder', refId: id,
        })
      }
      return reply.status(201).send(revision)
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(409).send({ error: '该订单已有待确认修改或请求已提交' })
      throw error
    }
  })

  app.get('/:id/revisions', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, role, supplierId, storeId } = req.user
    const { id } = req.params as any
    const where: any = { id, tenantId }
    const scopedSupplierId = requireSupplierBinding(role, supplierId)
    if (scopedSupplierId) where.supplierId = scopedSupplierId
    if (isStoreScoped(role)) where.storeId = storeId
    const exists = await prisma.purchaseOrder.findFirst({ where, select: { id: true } })
    if (!exists) return reply.status(404).send({ error: '订单不存在' })
    return prisma.purchaseOrderRevision.findMany({
      where: { purchaseOrderId: id }, orderBy: { revisionNo: 'asc' },
      include: {
        requestedBy: { select: { id: true, name: true, role: true } },
        reviewedBy: { select: { id: true, name: true, role: true } },
      },
    })
  })

  // ── 门店确认/驳回供应商改单 ────────────────────────────────────────
  app.patch('/:id/revisions/:revisionId/approve', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = revisionReviewSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, userId, role, storeId } = req.user
    const { id, revisionId } = req.params as any
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅门店有权确认改单' })
    }
    const revision = await prisma.purchaseOrderRevision.findFirst({
      where: { id: revisionId, purchaseOrderId: id, tenantId, status: 'PENDING' },
      include: { purchaseOrder: { include: { items: true } } },
    })
    if (!revision) return reply.status(404).send({ error: '待确认改单不存在' })
    const order = revision.purchaseOrder
    if (order.status !== 'SUBMITTED') return reply.status(409).send({ error: '订单已接单或状态已变化，不能再批准' })
    if (isStoreScoped(role) && order.storeId !== storeId) return reply.status(404).send({ error: '待确认改单不存在' })
    if (role === 'CHEF_DIRECTOR' && order.createdById !== userId) return reply.status(403).send({ error: '只能确认自己代下的订单' })
    if (order.rowVersion !== revision.baseRowVersion) return reply.status(409).send({ error: '订单已更新，请刷新后重新处理' })

    const after = revision.afterSnapshot as unknown as OrderSnapshot
    const desired = new Map(after.items.map(item => [item.productId, item]))
    await prisma.$transaction(async (tx) => {
      const locked = await tx.purchaseOrder.updateMany({
        where: { id, status: 'SUBMITTED', rowVersion: revision.baseRowVersion },
        data: {
          expectedDate: new Date(after.expectedDate), note: after.note,
          // totalAmount 暂作旧客户端的“当前金额”兼容字段；首次提交金额只读 originalTotalAmount / submittedSnapshot。
          totalAmount: new Prisma.Decimal(after.totalAmount),
          currentOrderAmount: new Prisma.Decimal(after.totalAmount), currentRevisionNo: revision.revisionNo,
          rowVersion: { increment: 1 },
        },
      })
      if (locked.count === 0) throw { statusCode: 409, message: '订单已被其他人处理，请刷新' }

      for (const item of order.items) {
        const next = desired.get(item.productId)
        if (!next) {
          await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { isActive: false, lastRevisionId: revision.id } })
          continue
        }
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            quantity: new Prisma.Decimal(next.quantity), amount: new Prisma.Decimal(next.amount),
            isActive: true, lastRevisionId: revision.id,
          },
        })
        desired.delete(item.productId)
      }
      for (const next of desired.values()) {
        await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: id, productId: next.productId,
            quantity: new Prisma.Decimal(next.quantity), unitPrice: new Prisma.Decimal(next.unitPrice), amount: new Prisma.Decimal(next.amount),
            lineOrigin: 'APPROVED_REVISION', isActive: true, lastRevisionId: revision.id,
          },
        })
      }
      await tx.purchaseOrderRevision.update({
        where: { id: revision.id },
        data: { status: 'APPROVED', reviewedById: userId, reviewedAt: new Date(), reviewNote: parsed.data.note || null },
      })
      await tx.purchaseOrderEvent.create({
        data: {
          tenantId, purchaseOrderId: id, eventType: 'REVISION_APPROVED', actorId: userId, actorRole: role,
          fromStatus: order.status, toStatus: order.status, requestId: req.id, ip: req.ip,
          metadata: { revisionId: revision.id, revisionNo: revision.revisionNo, changes: revision.changeSet },
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, action: `确认订货单修改 ${order.no} (第 ${revision.revisionNo} 次)`,
          target: order.no, entityType: 'PurchaseOrderRevision', targetId: revision.id,
          metadata: { changes: revision.changeSet },
        },
      })
    })
    const supplierRecipients = await prisma.user.findMany({
      where: { tenantId, supplierId: order.supplierId, status: 'ACTIVE', role: { in: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'] } },
      select: { id: true, role: true },
    })
    for (const recipient of supplierRecipients) {
      void sendNotification({
        tenantId, recipientRole: recipient.role, recipientId: recipient.id,
        type: 'ORDER_REVISION_APPROVED' as any,
        title: `改单已确认 ${order.no}`,
        body: `门店已确认第 ${revision.revisionNo} 次改单，现在可以接单。`,
        refType: 'PurchaseOrder', refId: id,
      })
    }
    return { success: true, revisionNo: revision.revisionNo, currentOrderAmount: after.totalAmount }
  })

  app.patch('/:id/revisions/:revisionId/reject', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = revisionReviewSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, userId, role, storeId } = req.user
    const { id, revisionId } = req.params as any
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅门店有权驳回改单' })
    }
    const revision = await prisma.purchaseOrderRevision.findFirst({
      where: { id: revisionId, purchaseOrderId: id, tenantId, status: 'PENDING' },
      include: { purchaseOrder: true },
    })
    if (!revision) return reply.status(404).send({ error: '待确认改单不存在' })
    if (isStoreScoped(role) && revision.purchaseOrder.storeId !== storeId) return reply.status(404).send({ error: '待确认改单不存在' })
    if (role === 'CHEF_DIRECTOR' && revision.purchaseOrder.createdById !== userId) return reply.status(403).send({ error: '只能处理自己代下的订单' })
    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrderRevision.updateMany({
        where: { id: revision.id, status: 'PENDING' },
        data: { status: 'REJECTED', reviewedById: userId, reviewedAt: new Date(), reviewNote: parsed.data.note || null },
      })
      if (updated.count === 0) throw { statusCode: 409, message: '改单已被其他人处理' }
      await tx.purchaseOrderEvent.create({
        data: {
          tenantId, purchaseOrderId: id, eventType: 'REVISION_REJECTED', actorId: userId, actorRole: role,
          fromStatus: revision.purchaseOrder.status, toStatus: revision.purchaseOrder.status, requestId: req.id, ip: req.ip,
          metadata: { revisionId: revision.id, revisionNo: revision.revisionNo, note: parsed.data.note || null },
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, action: `驳回订货单修改 ${revision.purchaseOrder.no} (第 ${revision.revisionNo} 次)`,
          target: revision.purchaseOrder.no, entityType: 'PurchaseOrderRevision', targetId: revision.id,
        },
      })
    })
    const supplierRecipients = await prisma.user.findMany({
      where: {
        tenantId, supplierId: revision.purchaseOrder.supplierId, status: 'ACTIVE',
        role: { in: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'] },
      },
      select: { id: true, role: true },
    })
    for (const recipient of supplierRecipients) {
      void sendNotification({
        tenantId, recipientRole: recipient.role, recipientId: recipient.id,
        type: 'ORDER_REVISION_REJECTED' as any,
        title: `改单被驳回 ${revision.purchaseOrder.no}`,
        body: parsed.data.note || '门店未同意本次改单，请按原订货单处理或联系门店。',
        refType: 'PurchaseOrder', refId: id,
      })
    }
    return { success: true }
  })

  // ── 供应商接单 ────────────────────────────────
  app.patch('/:id/confirm', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }

    const where: any = { id, tenantId, status: 'SUBMITTED' }
    const scopedSupplierId = requireSupplierBinding(role, req.user.supplierId)
    if (scopedSupplierId) where.supplierId = scopedSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where,
      include: {
        supplier: { select: { inventoryMode: true } },
        revisions: { where: { status: 'PENDING' }, select: { id: true } },
        items: {
          where: { isActive: true },
          include: { product: { select: { name: true } } },
        },
      },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在或当前状态不可接单' }
    if (order.revisions.length > 0) throw { statusCode: 409, message: '订单有待门店确认的修改，确认完成后才能接单' }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrder.updateMany({
        where: { id, status: 'SUBMITTED', rowVersion: order.rowVersion },
        data: { status: 'CONFIRMED', rowVersion: { increment: 1 } },
      })
      if (updated.count === 0) throw { statusCode: 409, message: '订单状态已变化，请刷新后重试' }
      if (order.supplier.inventoryMode === 'STRICT') {
        await reserveSupplierStockForOrder(tx, {
          tenantId,
          supplierId: order.supplierId,
          purchaseOrderId: order.id,
          lines: order.items.map(item => ({
            purchaseOrderItemId: item.id,
            productId: item.productId,
            quantity: item.quantity,
            productName: item.product?.name,
          })),
        })
      }
      await tx.purchaseOrderEvent.create({
        data: {
          tenantId, purchaseOrderId: id, eventType: 'ACCEPTED', actorId: userId, actorRole: role,
          fromStatus: 'SUBMITTED', toStatus: 'CONFIRMED', requestId: req.id, ip: req.ip,
        },
      })
      await tx.opLog.create({
        data: { tenantId, userId, action: '供应商接单', target: order.no, entityType: 'PurchaseOrder', targetId: id },
      })
    })
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void notifyOrderConfirmed(tenantId, order.no, sup?.name || '', order.storeId)
    notify({
      tenantId, event: 'PO_ACCEPTED',
      eventKey: `PO:${order.id}:ACCEPTED`,
      payload: { orderId: order.id, no: order.no, supplierName: sup?.name || '' },
      toStoreIds: order.storeId ? [order.storeId] : undefined,
    })
    return { success: true }
  })

  // ── 旧版代加入口已封口: 禁止接单后直接篡改原始订货单 ───────────────────────
  app.post('/:id/add-items', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { role } = req.user
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商 / 管理员可代加' })
    }
    return reply.status(409).send({
      error: '接单后不能直接修改原始订货单。请在接单前使用“申请调整”，由门店确认后再接单。',
      migrationEndpoint: `/api/orders/${req.params.id}/revisions`,
    })
  })

  // ── 供应商拒单 ────────────────────────────────
  app.patch('/:id/reject', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { reason } = (req.body || {}) as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    if (!reason || !String(reason).trim()) throw { statusCode: 400, message: '请说明拒单原因' }
    const where: any = { id, tenantId, status: { in: ['SUBMITTED', 'CONFIRMED'] } }
    const scopedSupplierId = requireSupplierBinding(role, req.user.supplierId)
    if (scopedSupplierId) where.supplierId = scopedSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where,
      include: { revisions: { where: { status: 'PENDING' }, select: { id: true } } },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在或当前状态不可拒单' }
    if (order.revisions.length > 0) throw { statusCode: 409, message: '订单有待门店确认的修改，请等待门店处理后再拒单' }
    const rejectReason = String(reason).trim().slice(0, 100)
    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrder.updateMany({
        where: { id, status: order.status, rowVersion: order.rowVersion },
        data: {
          status: 'CANCELLED', cancelReason: rejectReason, cancelledAt: new Date(), cancelledById: userId,
          rowVersion: { increment: 1 },
        },
      })
      if (updated.count === 0) throw { statusCode: 409, message: '订单状态已变化，请刷新后重试' }
      if (order.status === 'CONFIRMED') await releaseSupplierStockForOrder(tx, id)
      await tx.purchaseOrderEvent.create({
        data: {
          tenantId, purchaseOrderId: id, eventType: 'CANCELLED', actorId: userId, actorRole: role,
          fromStatus: order.status, toStatus: 'CANCELLED', requestId: req.id, ip: req.ip,
          metadata: { reason: rejectReason, source: 'SUPPLIER_REJECT' },
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, action: `供应商拒单: ${rejectReason}`,
          target: order.no, entityType: 'PurchaseOrder', targetId: id,
        },
      })
    })
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void notifyOrderRejected(tenantId, order.no, sup?.name || '', rejectReason, order.storeId)
    return { success: true }
  })

  // ── 供应商确认发货 ────────────────────────────────
  app.patch('/:id/ship', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    // body 可选传 items: [{ itemId, shippedQty }] — 称重 / 缺货时供应商按实际发货量调整
    const parsedShip = deliveryShipSchema.safeParse(req.body || {})
    if (!parsedShip.success) return reply.status(400).send({ error: parsedShip.error.issues[0].message })
    const { note, items: shippedItems, idempotencyKey } = parsedShip.data

    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const scopedSupplierId = requireSupplierBinding(role, req.user.supplierId)

    // 网络重试必须在检查订货单当前状态前命中，否则首次发货已把 PO 改为 DELIVERING，重试会误报不可发货。
    const duplicateWhere: any = { purchaseOrderId: id, idempotencyKey, tenantId }
    if (scopedSupplierId) duplicateWhere.supplierId = scopedSupplierId
    const duplicate = await prisma.deliveryOrder.findFirst({ where: duplicateWhere })
    if (duplicate) return { success: true, deliveryId: duplicate.id, deliveryNo: duplicate.no, duplicated: true }

    // P0: 加 supplier scope, 防供应商 A 替供应商 B 发货
    const shipWhere: any = { id, tenantId, status: 'CONFIRMED' }
    if (scopedSupplierId) shipWhere.supplierId = scopedSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where: shipWhere,
      // 实发上限是 per-product 配置 (shipUpperPct + shipUpperBuffer), 同时拉出来用于 ship 校验
      include: {
        supplier: { select: { inventoryMode: true } },
        items: { where: { isActive: true }, include: { product: { select: { name: true, unit: true, spec: true, code: true, category: true, shipUpperPct: true, shipUpperBuffer: true } } } },
        deliveries: { where: { status: { not: 'CANCELLED' } }, include: { items: true } },
      },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在或状态不可发货' }
    if (order.deliveries.some(d => d.status === 'SHIPPED' || d.status === 'DELIVERED')) {
      throw { statusCode: 409, message: '已有配送单在途或待收货，请完成本次收货后再创建补送' }
    }
    const priorShipped = new Map<string, number>()
    for (const delivery of order.deliveries) {
      if (delivery.status === 'DRAFT') continue
      for (const item of delivery.items) priorShipped.set(item.productId, (priorShipped.get(item.productId) || 0) + Number(item.shippedQty))
    }

    // 校验 + 构建 itemId → shippedQty 映射 (没传的按 quantity 全发)
    const shippedMap = new Map<string, number>()
    if (Array.isArray(shippedItems)) {
      for (const s of shippedItems) {
        const orig = order.items.find(o => o.id === s.itemId)
        if (!orig) throw { statusCode: 400, message: `行 ${s.itemId} 不属于本订单` }
        const sq = Number(s.shippedQty)
        if (!Number.isFinite(sq) || sq < 0) throw { statusCode: 400, message: `${orig.product?.name || s.itemId} 数量非法` }
        // 实发上限 = max(下单 × shipUpperPct, 下单 + shipUpperBuffer), per-product 配置
        // 字段在 Product 上 (2026-05-28 戊方案), 默认 1.10 / 5.00 跟之前全局阈值一致
        // 供应商可在 supplier/products 编辑 (price/spec/stock 同款 SUPPLIER_ALLOW 白名单)
        const ordered = Number(orig.quantity)
        const cumulative = (priorShipped.get(orig.productId) || 0) + sq
        const pct    = Number((orig.product as any)?.shipUpperPct    ?? 1.10)
        const buffer = Number((orig.product as any)?.shipUpperBuffer ?? 5.00)
        const upper  = Math.max(ordered * pct, ordered + buffer)
        if (cumulative > upper + 0.0001) {
          throw { statusCode: 400, message: `${orig.product?.name || s.itemId} 累计实发 ${cumulative} 超过上限 ${upper.toFixed(2)} (下单 ${ordered}), 请先走订货单修订` }
        }
        shippedMap.set(s.itemId, sq)
      }
    }
    // 计算每行实发 (默认 = quantity)
    const lineShipped = order.items.map(it => ({
      it,
      previous: priorShipped.get(it.productId) || 0,
      shipped: shippedMap.has(it.id) ? shippedMap.get(it.id)! : Math.max(0, Number(it.quantity) - (priorShipped.get(it.productId) || 0)),
    }))
    if (!lineShipped.some(line => line.shipped > 0)) throw { statusCode: 400, message: '本次配送数量必须大于 0' }
    const quantityOverflow = lineShipped.some(line =>
      new Prisma.Decimal(line.previous).add(line.shipped).gt(PURCHASE_QUANTITY_MAX)
    )
    if (quantityOverflow) throw { statusCode: 400, message: '累计实发数量超过系统上限' }
    const newLineAmounts = lineShipped.map(line =>
      new Prisma.Decimal(line.shipped).mul(line.it.unitPrice).toDecimalPlaces(2)
    )
    const cumulativeLineAmounts = lineShipped.map(line =>
      new Prisma.Decimal(line.previous).add(line.shipped).mul(line.it.unitPrice).toDecimalPlaces(2)
    )
    const newTotalAmount = newLineAmounts.reduce((sum, amount) => sum.add(amount), new Prisma.Decimal(0)).toDecimalPlaces(2)
    const cumulativeTotalAmount = cumulativeLineAmounts.reduce((sum, amount) => sum.add(amount), new Prisma.Decimal(0)).toDecimalPlaces(2)
    const amountError = orderAmountBoundError(
      [...newLineAmounts, ...cumulativeLineAmounts],
      Prisma.Decimal.max(newTotalAmount, cumulativeTotalAmount),
    )
    if (amountError) throw { statusCode: 400, message: amountError }
    const newTotal = Number(newTotalAmount)
    const cumulativeTotal = Number(cumulativeTotalAmount)
    const oldTotal = Number(order.totalAmount)
    const changedLines = lineShipped.filter(l => Math.abs(l.shipped - Number(l.it.quantity)) > 0.0001)

    // 注:发货后只是 DELIVERING (在途), 不启动倒计时. 待供应商点「送达」改 PENDING_CONFIRM 才计时

    // 事务: 更新 PO 状态 + 行 shippedQty + 总金额 + 自动扣减供应商库存
    let deliveryResult: { id: string; no: string }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchaseOrder.updateMany({
        where: {
          id: order.id,
          tenantId,
          status: 'CONFIRMED',
          rowVersion: order.rowVersion,
          ...(scopedSupplierId ? { supplierId: scopedSupplierId } : {}),
        },
        data: {
          status: 'DELIVERING' as any,
          shippedAt: new Date(),
          shippedNote: note,
          shippedById: userId,
          totalAmount: cumulativeTotalAmount,
          rowVersion: { increment: 1 },
        },
      })
      if (claimed.count === 0) {
        throw { statusCode: 409, message: '订单已被其他人处理，请刷新后重试' }
      }

      const ym = dayjs().format('YYYYMM')
      const deliveryNo = await nextBusinessNo(tx, tenantId, 'DO', ym, 'DO')
      const delivery = await tx.deliveryOrder.create({
        data: {
          tenantId, no: deliveryNo, purchaseOrderId: order.id, storeId: order.storeId, supplierId: order.supplierId,
          status: 'SHIPPED', actualTotalAmount: newTotalAmount, note: note || null,
          idempotencyKey, createdById: userId, shippedById: userId, shippedAt: new Date(),
          items: {
            create: lineShipped.filter(line => line.shipped > 0).map(line => ({
              purchaseOrderItemId: line.it.id, productId: line.it.productId,
              orderedQtySnapshot: line.it.quantity, shippedQty: new Prisma.Decimal(line.shipped),
              unitPriceSnapshot: line.it.unitPrice, amount: new Prisma.Decimal(line.shipped).mul(line.it.unitPrice).toDecimalPlaces(2),
              productCodeSnapshot: line.it.product?.code || null,
              productNameSnapshot: line.it.product?.name || null,
              productSpecSnapshot: line.it.product?.spec || null,
              productUnitSnapshot: line.it.product?.unit || null,
              productCategorySnapshot: line.it.product?.category || null,
            })),
          },
        },
      })
      deliveryResult = { id: delivery.id, no: delivery.no }
      await tx.deliveryOrderEvent.createMany({
        data: [
          { tenantId, deliveryOrderId: delivery.id, eventType: 'CREATED', actorId: userId, actorRole: role, toStatus: 'DRAFT', requestId: req.id, ip: req.ip },
          { tenantId, deliveryOrderId: delivery.id, eventType: 'SHIPPED', actorId: userId, actorRole: role, fromStatus: 'DRAFT', toStatus: 'SHIPPED', requestId: req.id, ip: req.ip },
        ],
      })
      // 写入每行 shippedQty + 重算行 amount (不动 unitPrice)
      for (const l of lineShipped) {
        await tx.purchaseOrderItem.update({
          where: { id: l.it.id },
          data: {
            shippedQty: new Prisma.Decimal(l.previous).add(l.shipped),
            amount: new Prisma.Decimal(l.previous).add(l.shipped).mul(l.it.unitPrice).toDecimalPlaces(2),
          },
        })
      }
      if (order.supplier.inventoryMode === 'STRICT') {
        await consumeSupplierStockForShipment(tx, {
          tenantId,
          supplierId: order.supplierId,
          purchaseOrderId: order.id,
          deliveryOrderId: delivery.id,
          orderNo: order.no,
          userId,
          lines: lineShipped.map(line => ({
            purchaseOrderItemId: line.it.id,
            productId: line.it.productId,
            quantity: line.it.quantity,
            shippedQty: line.shipped,
            productName: line.it.product?.name,
          })),
        })
      } else {
        // 供应商在试运行期可能从 STRICT 切回 NOT_TRACKED；释放历史预占，
        // 但不改 Product.stock，也不制造无法审计的负库存/空批次扣减。
        await releaseSupplierStockForOrder(tx, order.id)
      }
    })

    // opLog — 调整数量时详细记录
    const adjustNote = changedLines.length > 0
      ? '调整: ' + changedLines.map(l => `${l.it.product?.name || l.it.id} ${l.it.quantity}→${l.shipped}`).join(', ')
      : ''
    await prisma.opLog.create({
      data: {
        tenantId, userId, isAi: false,
        action: `供应商确认发货${adjustNote ? ' (' + adjustNote + ')' : ''}, 金额 ¥${newTotal.toFixed(2)}${Math.abs(newTotal - oldTotal) > 0.01 ? ` (原 ¥${oldTotal.toFixed(2)})` : ''}`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
        metadata: { oldTotal, newTotal, changedLines: changedLines.map(l => ({ name: l.it.product?.name, ordered: Number(l.it.quantity), shipped: l.shipped })) },
      },
    })

    // 通知 — 调整时高亮告知店长 / 厨师长
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    const adjustSummary = changedLines.length > 0
      ? `, 因 ${changedLines.slice(0, 2).map(l => `${l.it.product?.name || ''}${Number(l.it.quantity)}→${l.shipped}`).join(' / ')}${changedLines.length > 2 ? ` 等 ${changedLines.length} 项` : ''} 调整, 现 ¥${newTotal.toFixed(2)} (原 ¥${oldTotal.toFixed(2)})`
      : ''
    void notifyOrderShipped(tenantId, order.no, (supplier?.name || '') + adjustSummary, order.storeId)
    notify({
      tenantId, event: 'PO_DELIVERING',
      eventKey: `PO:${order.id}:DELIVERING`,
      payload: { orderId: order.id, no: order.no, supplierName: supplier?.name || '', total: newTotal },
      toStoreIds: [order.storeId],
    })
    return { success: true, deliveryId: deliveryResult!.id, deliveryNo: deliveryResult!.no, newTotal, cumulativeTotal, oldTotal, changedLines: changedLines.length }
  })

  // ── 供应商/司机点「已送达」 ─ DELIVERING → PENDING_CONFIRM, 启动 24h 自动收货 ──
  app.patch('/:id/deliver', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商 / 管理员可标记送达' })
    }
    const parsedDeliver = deliveryDeliverSchema.safeParse(req.body || {})
    if (!parsedDeliver.success) return reply.status(400).send({ error: parsedDeliver.error.issues[0].message })
    const { note } = parsedDeliver.data
    const where: any = { id, tenantId, status: 'DELIVERING' }
    const scopedSupplierId = requireSupplierBinding(role, req.user.supplierId)
    if (scopedSupplierId) where.supplierId = scopedSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where,
      include: { deliveries: { where: { status: 'SHIPPED' }, orderBy: { shippedAt: 'desc' }, take: 1 } },
    })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 状态不可送达' })
    const delivery = order.deliveries[0]
    if (!delivery) return reply.status(409).send({ error: '未找到可送达的独立配送单' })
    const deliveredAt = new Date()
    await prisma.$transaction(async tx => {
      const upd = await tx.deliveryOrder.updateMany({
        where: { id: delivery.id, status: 'SHIPPED', rowVersion: delivery.rowVersion },
        data: { status: 'DELIVERED', deliveredAt, deliveredById: userId, rowVersion: { increment: 1 } },
      })
      if (upd.count === 0) throw { statusCode: 409, message: '配送单状态已变化，请刷新' }
      await tx.purchaseOrder.updateMany({
        where: { id, status: 'DELIVERING' },
        data: { status: 'PENDING_CONFIRM', deliveredAt, deliveredNote: note, deliveredById: userId },
      })
      await tx.deliveryOrderEvent.create({
        data: {
          tenantId, deliveryOrderId: delivery.id, eventType: 'DELIVERED', actorId: userId, actorRole: role,
          fromStatus: 'SHIPPED', toStatus: 'DELIVERED', requestId: req.id, ip: req.ip,
        },
      })
    })
    const autoConfirmAt = dayjs().add(24, 'hour').toDate()
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `供应商标记送达${note ? ': ' + String(note).slice(0,80) : ''}, 24h 内门店未确认将自动收货`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
        metadata: { autoConfirmAt },
      },
    })
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void sendNotification({
      tenantId, recipientRole: 'MANAGER' as any,
      type: 'ORDER_DELIVERED' as any,
      title: `订单已送达, 请尽快验收 ${order.no}`,
      body: `${supplier?.name || ''} 已送达, 请 24h 内确认收货, 否则系统将自动确认`,
      refType: 'PurchaseOrder', refId: id,
    })
    notify({
      tenantId, event: 'PO_PENDING_CONFIRM',
      eventKey: `PO:${order.id}:PENDING_CONFIRM`,
      payload: {
        orderId: order.id, no: order.no, supplierName: supplier?.name || '',
        total: Number(order.totalAmount),
      },
      toStoreIds: [order.storeId],
    })
    return { success: true, autoConfirmAt }
  })

  // ── 厨师发送验收单 ─ DELIVERING 状态下, 收到货物后传照片+(选填)备注给供应商 ──
  // 2026-05-29 客户反馈: 供应商点"送达"前需要看到客户的验收单 (软约束 — 不强制阻断)
  // 限制: 上限 5 张图 (前后端双校验); 备注选填, 提供则上限 500 字
  app.patch('/:id/chef-ack', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    if (!['KITCHEN_LEAD', 'MANAGER', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅厨师长 / 店长 / 总厨 / 老板可发验收单' })
    }
    const parsedAck = chefAckSchema.safeParse(req.body || {})
    if (!parsedAck.success) return reply.status(400).send({ error: parsedAck.error.issues[0].message })
    const { images, note } = parsedAck.data
    const noteValue = note?.trim() || ''
    const where: any = { id, tenantId, status: 'DELIVERING' }
    // 厨师/店长只能给自己绑定门店的单发验收单
    if (['KITCHEN_LEAD', 'MANAGER'].includes(role) && storeId) where.storeId = storeId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 状态非"在途"不可发验收单' })
    const ackedAt = new Date()
    await prisma.$transaction(async tx => {
      const updated = await tx.purchaseOrder.updateMany({
        where,
        data: {
          chefAckImages: images,
          chefAckAt: ackedAt,
          chefAckNote: noteValue || null,
        },
      })
      if (updated.count === 0) throw { statusCode: 409, message: '订单状态已变化，请刷新后重试' }
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `厨师发送验收单 (${images.length} 张照片)${noteValue ? ': ' + noteValue.slice(0, 80) : ''}`,
          target: order.no, entityType: 'PurchaseOrder', targetId: id,
          metadata: { imagesCount: images.length },
        },
      })
    })
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    const store = await prisma.store.findUnique({ where: { id: order.storeId }, select: { name: true } })
    void sendNotification({
      tenantId, recipientRole: 'SUPPLIER_OWNER' as any,
      type: 'CHEF_ACK_SENT' as any,
      title: `${store?.name || '门店'} 已发验收单 ${order.no}`,
      body: `客户已收货并发送验收单 (${images.length} 张照片), 请查看后点"已送达"`,
      refType: 'PurchaseOrder', refId: id,
    })
    return { success: true, ackedAt }
  })

  // ── 门店确认收货（完全一致）──────────────────────
  app.patch('/:id/receive', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    const parsedReceive = deliveryReceiveSchema.safeParse(req.body || {})
    if (!parsedReceive.success) return reply.status(400).send({ error: parsedReceive.error.issues[0].message })
    const { items: receivedItems, evidenceImages, reason, kind } = parsedReceive.data
    const lossReason = (typeof reason === 'string' && reason.trim()) ? reason.trim().slice(0, 30) : null
    const lossKind = kind ?? 'ARRIVAL_SHORTAGE'

    const findDuplicateReceiptResponse = async (deliveryOrderId?: string) => {
      const duplicateWhere: any = {
        tenantId,
        purchaseOrderId: id,
        deliveryOrderId: deliveryOrderId || { not: null },
      }
      if (isStoreScoped(role)) duplicateWhere.storeId = storeId
      const existingReceipt = await prisma.receipt.findFirst({
        where: duplicateWhere,
        orderBy: { createdAt: 'desc' },
      })
      if (!existingReceipt) return null
      try {
        const { ensureReceiptDerivatives } = await import('../services/receiptDerivatives')
        await ensureReceiptDerivatives(existingReceipt.id)
      } catch (error) {
        req.log.warn({ err: error, receiptId: existingReceipt.id }, '重复收货补偿财务派生记录失败')
      }
      const currentOrder = await prisma.purchaseOrder.findFirst({
        where: { id, tenantId, ...(isStoreScoped(role) ? { storeId } : {}) },
        select: { status: true },
      })
      const fullyShipped = currentOrder?.status !== 'CONFIRMED'
      return {
        success: true,
        receipt: existingReceipt,
        deliveryId: existingReceipt.deliveryOrderId,
        fullyShipped,
        remainingDelivery: !fullyShipped,
        duplicated: true,
      }
    }

    // P1-1: 仅店长 / 厨师长 / 老板 / 超管 能确认收货 (供应商不该能调)
    if (!['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '仅门店人员可确认收货' }
    }

    // 加 store scope: 店长/厨师长 只能确认本店的单
    const orderWhere: any = { id, tenantId, status: 'PENDING_CONFIRM' }
    if (isStoreScoped(role)) orderWhere.storeId = storeId
    const order = await prisma.purchaseOrder.findFirst({
      where: orderWhere,
      include: {
        items: { where: { isActive: true } }, supplier: true,
        deliveries: {
          where: { status: 'DELIVERED' }, orderBy: { deliveredAt: 'desc' }, take: 1,
          include: { items: { include: { product: { select: { shelfDays: true } } } } },
        },
      },
    })
    if (!order) {
      // 客户端可能在收货成功后因断网未拿到响应并重试。此时 PO 已离开
      // PENDING_CONFIRM，但 deliveryOrderId 的唯一约束已经证明该配送单收过货。
      // 返回原入库单，避免把一次成功操作表现成失败，也避免前端诱导重复处理。
      const duplicate = await findDuplicateReceiptResponse()
      if (duplicate) return duplicate
      throw { statusCode: 400, message: '订单不存在 / 非待确认 / 非本店' }
    }
    const delivery = order.deliveries[0]
    if (!delivery) throw { statusCode: 409, message: '未找到待收货的独立配送单' }

    const receivedProductIds = (receivedItems || []).map(item => item.productId)
    if (new Set(receivedProductIds).size !== receivedProductIds.length) {
      throw { statusCode: 400, message: '同一商品不能重复提交多行实收数量' }
    }
    const receivedMap = new Map<string, number>()
    for (const ri of receivedItems || []) {
      const item = delivery.items.find(i => i.productId === ri.productId)
      const qty = ri.receivedQty
      if (!item) throw { statusCode: 400, message: `商品 ${ri.productId} 不属于本次配送` }
      if (!Number.isFinite(qty) || qty < 0 || qty > Number(item.shippedQty) + 0.0001) {
        throw { statusCode: 400, message: `商品实收数量必须在 0 至 ${item.shippedQty} 之间` }
      }
      receivedMap.set(ri.productId, qty)
    }
    const deliveryReceivedItems = delivery.items.map(item => ({
      ...item,
      actualReceivedQty: receivedMap.has(item.productId) ? receivedMap.get(item.productId)! : Number(item.shippedQty),
    }))

    // P0-1: Receipt.totalAmount = sum(receivedQty * unitPrice), 不再用 order.totalAmount
    // receivedQty 缺省时按 shippedQty (供应商实际发货) → 没 shippedQty 才回退 quantity
    const actualReceivedTotal = deliveryReceivedItems.reduce(
      (sum, item) => sum + item.actualReceivedQty * Number(item.unitPriceSnapshot), 0,
    )

    // 判断是否存在报损 — 应到 = shippedQty (ship 时议定的量), 实收 < 应到 才算报损
    // 供应商在 ship 时调减不算报损 (金额已按实发算清, 没有未付的钱)
    const lossLines = deliveryReceivedItems
      .map(item => {
        const original = order.items.find(i => i.productId === item.productId)
        const expected = Number(item.shippedQty)
        const lossQty = expected - item.actualReceivedQty
        if (lossQty <= 0) return null
        return {
          productId: item.productId,
          deliveryOrderItemId: item.id,
          orderedQty: original?.quantity ?? item.orderedQtySnapshot,
          receivedQty: item.actualReceivedQty,
          lossQty,
          unitPrice: item.unitPriceSnapshot,
          lossAmount: lossQty * Number(item.unitPriceSnapshot),
          productCodeSnapshot: item.productCodeSnapshot,
          productNameSnapshot: item.productNameSnapshot,
          productSpecSnapshot: item.productSpecSnapshot,
          productUnitSnapshot: item.productUnitSnapshot,
          productCategorySnapshot: item.productCategorySnapshot,
        }
      })
      .filter(Boolean) as Array<{
        productId: string; deliveryOrderItemId: string; orderedQty: any; receivedQty: number;
        lossQty: number; unitPrice: any; lossAmount: number;
        productCodeSnapshot: string | null; productNameSnapshot: string | null;
        productSpecSnapshot: string | null; productUnitSnapshot: string | null;
        productCategorySnapshot: string | null;
      }>

    const hasLoss = lossLines.length > 0

    // 证据改为可选 (2026-06 客户要求): 不再强制上传. 无证据时供应商更易拒赔, UI 已给软提示.
    const fullyShipped = order.items.every(item => Number(item.shippedQty || 0) + 0.0001 >= Number(item.quantity))
    const receivedAt = new Date()
    const ym = dayjs(receivedAt).format('YYYYMM')
    let committed: { receipt: any; no: string }
    try {
      committed = await prisma.$transaction(async tx => {
        // 首条成功请求锁住并推进配送单；并发请求等待后会得到 count=0，转为幂等响应。
        const claimed = await tx.deliveryOrder.updateMany({
          where: { id: delivery.id, tenantId, status: 'DELIVERED', rowVersion: delivery.rowVersion },
          data: { status: 'RECEIVED', receivedAt, receivedById: userId, rowVersion: { increment: 1 } },
        })
        if (claimed.count !== 1) throw new ReceiptAlreadyProcessedError()

        const latestReceipt = await tx.receipt.findFirst({
          where: { tenantId, no: { startsWith: `RK${ym}` } },
          orderBy: { no: 'desc' }, select: { no: true },
        })
        const receiptFloor = Number(latestReceipt?.no.slice(`RK${ym}`.length) || 0)
        const no = await nextBusinessNo(tx, tenantId, 'RECEIPT', ym, 'RK', receiptFloor)
        const receipt = await tx.receipt.create({
          data: {
            tenantId, no,
            purchaseOrderId: order.id,
            deliveryOrderId: delivery.id,
            storeId: order.storeId,
            supplierId: order.supplierId,
            deliveryDate: receivedAt,
            totalAmount: actualReceivedTotal,
            status: 'CONFIRMED',
            confirmedAt: receivedAt,
            createdById: userId,
            items: {
              create: deliveryReceivedItems.map(item => ({
                productId: item.productId,
                quantity: new Prisma.Decimal(item.actualReceivedQty),
                unitPrice: item.unitPriceSnapshot,
                amount: new Prisma.Decimal(item.actualReceivedQty).mul(item.unitPriceSnapshot),
                productCodeSnapshot: item.productCodeSnapshot,
                productNameSnapshot: item.productNameSnapshot,
                productSpecSnapshot: item.productSpecSnapshot,
                productUnitSnapshot: item.productUnitSnapshot,
                productCategorySnapshot: item.productCategorySnapshot,
                productionDate: item.manufactureDate || receivedAt,
                expiryDate: item.expiryDate || dayjs(receivedAt).add(item.product.shelfDays, 'day').toDate(),
              })),
            },
          },
        })
        await ensureReceiptInventoryUnitSnapshots(tx, receipt.id)

        if (hasLoss) {
          const latestClaim = await tx.lossClaim.findFirst({
            where: { tenantId, no: { startsWith: `LC${ym}` } },
            orderBy: { no: 'desc' }, select: { no: true },
          })
          const claimFloor = Number(latestClaim?.no.slice(`LC${ym}`.length) || 0)
          const lcNo = await nextBusinessNo(tx, tenantId, 'LOSS_CLAIM', ym, 'LC', claimFloor)
          const totalLoss = lossLines.reduce((s, l) => s + l.lossAmount, 0)
          await tx.lossClaim.create({
            data: {
              tenantId, no: lcNo,
              kind: lossKind as any,
              payableBasis: 'NET_AT_RECEIPT',
              purchaseOrderId: id,
              deliveryOrderId: delivery.id,
              receiptId: receipt.id,
              storeId: order.storeId,
              supplierId: order.supplierId,
              totalLossAmount: totalLoss,
              reason: lossReason,
              description: lossReason
                ? `${lossReason} · 验收到货差异 (${order.no})`
                : lossKind === 'ARRIVAL_DAMAGE'
                  ? `验收破损/品质异常 (${order.no})`
                  : `验收短量自动记录 (${order.no})`,
              evidenceImages: Array.isArray(evidenceImages) ? evidenceImages.slice(0, 9) : [],
              status: 'PENDING' as any,
              createdById: userId,
              items: { create: lossLines },
            },
          })
          await tx.opLog.create({
            data: {
              tenantId, userId,
              action: `验收短量自动建报损 ${lcNo}，损失 ¥${totalLoss.toFixed(2)}`,
              target: lcNo, entityType: 'LossClaim',
            },
          })
        }

        for (const item of deliveryReceivedItems) {
          await tx.deliveryOrderItem.update({
            where: { id: item.id }, data: { receivedQty: new Prisma.Decimal(item.actualReceivedQty) },
          })
          const priorDeliveryReceived = await tx.deliveryOrderItem.aggregate({
            where: {
              productId: item.productId,
              deliveryOrder: { purchaseOrderId: id, status: 'RECEIVED', id: { not: delivery.id } },
            },
            _sum: { receivedQty: true },
          })
          await tx.purchaseOrderItem.updateMany({
            where: { purchaseOrderId: id, productId: item.productId },
            data: { receivedQty: new Prisma.Decimal(Number(priorDeliveryReceived._sum.receivedQty || 0) + item.actualReceivedQty) },
          })
        }
        await tx.deliveryOrderEvent.create({
          data: {
            tenantId, deliveryOrderId: delivery.id, eventType: 'RECEIVED', actorId: userId, actorRole: role,
            fromStatus: 'DELIVERED', toStatus: 'RECEIVED', requestId: req.id, ip: req.ip,
            metadata: { receiptId: receipt.id, hasLoss, actualReceivedTotal },
          },
        })
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            status: fullyShipped ? (hasLoss ? 'RECEIVED' : 'COMPLETED') : 'CONFIRMED',
            receivedAt: fullyShipped ? receivedAt : null,
            receiptId: receipt.id,
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `确认收货 ${order.no}，生成入库单 ${no}`,
            target: order.no, entityType: 'PurchaseOrder', targetId: id,
          },
        })
        return { receipt, no }
      })
    } catch (error) {
      if (error instanceof ReceiptAlreadyProcessedError) {
        const duplicate = await findDuplicateReceiptResponse(delivery.id)
        if (duplicate) return duplicate
      }
      throw error
    }
    const { receipt, no } = committed

    // 入库主事务后的派生记录独立、幂等；任一分支失败都由重复请求和每日扫描补偿。
    try {
      const { ensureReceiptDerivatives } = await import('../services/receiptDerivatives')
      const result = await ensureReceiptDerivatives(receipt.id)
      if (!result.voucher.ok || !result.finance.ok) {
        req.log.error({ receiptId: receipt.id, result }, '收货后财务派生记录未完整生成，等待幂等补偿')
      }
      if (hasLoss && result.finance.ok) {
        await prisma.paymentSchedule.updateMany({
          where: {
            receiptId: receipt.id,
            status: { in: ['PENDING', 'NOTIFIED', 'PENDING_APPROVAL', 'APPROVED', 'OVERDUE'] },
          },
          data: { status: 'ON_HOLD' },
        })
      }
    } catch (error) {
      // 收货主事务已经成功，不把派生财务流程的临时故障伪装成收货失败。
      // 客户端重试会进入上方幂等分支，再次补偿对账单和账期。
      req.log.error({ err: error, receiptId: receipt.id }, '收货后财务派生记录生成失败，等待幂等补偿')
    }
    await revalueStoreConsumptionCosts(tenantId, order.storeId).catch(error => {
      req.log.error({ error, receiptId: receipt.id }, 'received order cost snapshot refresh failed')
    })

    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    notify({
      tenantId, event: 'PO_RECEIVED',
      eventKey: `PO:${order.id}:RECEIVED`,
      payload: { orderId: order.id, no: order.no, total: Number(actualReceivedTotal), hasLoss },
      toSupplierIds: order.supplierId ? [order.supplierId] : undefined,
    })
    return { success: true, receipt, deliveryId: delivery.id, fullyShipped, remainingDelivery: !fullyShipped }
  })

  // (旧的宽松 /cancel 已删除, 取代为顶部带角色校验 + SUBMITTED 限制的版本)
}
