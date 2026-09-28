import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { businessMonthKey } from '../lib/businessTime'
import { calendarDateSchema } from '../lib/calendar-date'
import { hashRequestBody } from '../lib/idempotency'
import { isStoreScoped, isSupplierRole, storeScopeOf } from '../lib/auth-scope'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { businessNoFloor, nextBusinessNo } from '../services/purchaseOrderIntegrity'
import { loadOrderDraftProducts, validateOrderDraftLines } from '../services/orderDraftValidation'
import { acceptReplenishmentInTransaction } from '../services/replenishmentOrderService'
import { deriveReplenishmentFulfillmentStatus, replenishmentNextAction } from '../services/replenishmentOrderPolicy'

const quantity = z.number().finite().positive().max(99_999_999.99)
const createSchema = z.object({
  storeId: z.string().min(1),
  supplierId: z.string().min(1),
  expectedDate: calendarDateSchema,
  note: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().min(8).max(80),
  items: z.array(z.object({ productId: z.string().min(1), quantity }).strict()).min(1).max(500),
}).strict()
const editSchema = createSchema.omit({ idempotencyKey: true }).extend({
  rowVersion: z.number().int().nonnegative(),
  requestKey: z.string().trim().min(8).max(80),
}).strict()
const submitSchema = z.object({ requestKey: z.string().trim().min(8).max(80) }).strict()
const acceptSchema = z.object({ requestKey: z.string().trim().min(8).max(80) }).strict()
const cancelSchema = z.object({
  reason: z.string().trim().min(2).max(500),
  requestKey: z.string().trim().min(8).max(80),
}).strict()
const listSchema = z.object({
  status: z.enum(['DRAFT', 'SUBMITTED', 'ACCEPTED', 'FULFILLING', 'COMPLETED', 'CANCELLED', 'EXCEPTION']).optional(),
  storeId: z.string().optional(),
  supplierId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
})

function canWrite(user: any) {
  return isInternalSupplyChainRole(user?.role) && hasInternalSupplyChainCapability(user.role, 'order.write')
    || ['ADMIN', 'SUPER_ADMIN'].includes(user?.role || '')
}

function readScope(user: any) {
  const where: any = { tenantId: user.tenantId }
  if (isStoreScoped(user.role)) {
    const storeIds = storeScopeOf(user) || []
    if (storeIds.length === 0) throw Object.assign(new Error('未绑定可访问门店'), { statusCode: 403 })
    where.storeId = { in: storeIds }
    // DRAFT is an internal working copy. A store sees the proxy request only
    // after supply chain explicitly submits it.
    where.AND = [{ status: { not: 'DRAFT' } }]
  } else if (isSupplierRole(user.role)) {
    if (!user.supplierId) throw Object.assign(new Error('未绑定供应商'), { statusCode: 403 })
    where.supplierId = user.supplierId
    // A draft is still an internal supply-chain working copy. The supplier
    // gains visibility only after the request is explicitly submitted.
    where.AND = [{ status: { not: 'DRAFT' } }]
  } else if (!(isInternalSupplyChainRole(user.role) || ['ADMIN', 'SUPER_ADMIN'].includes(user.role || ''))) {
    throw Object.assign(new Error('无权查看门店补货单'), { statusCode: 403 })
  }
  return where
}

function createFingerprint(input: z.infer<typeof createSchema>) {
  return hashRequestBody({
    storeId: input.storeId,
    supplierId: input.supplierId,
    expectedDate: input.expectedDate,
    note: input.note || null,
    items: input.items
      .map(item => ({ productId: item.productId, quantity: new Prisma.Decimal(item.quantity).toFixed(2) }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  }, 'replenishment-order-create')
}

function editFingerprint(input: z.infer<typeof editSchema>) {
  return hashRequestBody({
    storeId: input.storeId,
    supplierId: input.supplierId,
    expectedDate: input.expectedDate,
    note: input.note || null,
    rowVersion: input.rowVersion,
    items: input.items
      .map(item => ({ productId: item.productId, quantity: new Prisma.Decimal(item.quantity).toFixed(2) }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  }, 'replenishment-order-edit')
}

function project(order: any) {
  const linkedStatus = order.fulfillment?.purchaseOrder?.status || null
  const displayStatus = deriveReplenishmentFulfillmentStatus({
    storedStatus: order.status,
    hasFulfillmentLink: Boolean(order.fulfillment),
    linkedOrderStatus: linkedStatus,
  })
  return { ...order, displayStatus, nextAction: replenishmentNextAction(displayStatus) }
}

function itemRows(products: any[], validation: ReturnType<typeof validateOrderDraftLines>) {
  const productById = new Map(products.map(product => [product.id, product]))
  return validation.lines.map(line => {
    const product = productById.get(line.productId)!
    return {
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
      productCodeSnapshot: product.code || null,
      productNameSnapshot: product.name,
      productSpecSnapshot: product.spec || null,
      productCategorySnapshot: product.category || null,
      purchaseUnitSnapshot: line.purchaseUnitSnapshot,
      inventoryUnitSnapshot: line.inventoryUnitSnapshot,
      orderUnitSnapshot: line.orderUnitSnapshot,
      costUnitSnapshot: line.costUnitSnapshot,
      unitConversionStatusSnapshot: line.unitConversionStatusSnapshot,
      inventoryUnitsPerPurchaseUnitSnapshot: line.inventoryUnitsPerPurchaseUnitSnapshot,
      inventoryUnitsPerOrderUnitSnapshot: line.inventoryUnitsPerOrderUnitSnapshot,
      inventoryUnitsPerCostUnitSnapshot: line.inventoryUnitsPerCostUnitSnapshot,
    }
  })
}

const detailSelect = {
  id: true,
  no: true,
  storeId: true,
  supplierId: true,
  expectedDate: true,
  totalAmount: true,
  status: true,
  source: true,
  note: true,
  rowVersion: true,
  submittedAt: true,
  acceptedAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  store: { select: { id: true, no: true, name: true } },
  supplier: { select: { id: true, no: true, name: true } },
  createdBy: { select: { id: true, name: true, role: true } },
  items: {
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitPrice: true,
      amount: true,
      productCodeSnapshot: true,
      productNameSnapshot: true,
      productSpecSnapshot: true,
      productCategorySnapshot: true,
      orderUnitSnapshot: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
  events: {
    select: {
      id: true,
      eventType: true,
      actorRole: true,
      actor: { select: { name: true } },
      fromStatus: true,
      toStatus: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: 'asc' as const },
  },
  fulfillment: {
    select: {
      id: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { id: true, no: true, status: true, expectedDate: true } },
    },
  },
}
const replaySelect = { ...detailSelect, requestFingerprint: true }

function projectReplay(order: any) {
  const { requestFingerprint: _privateFingerprint, ...safe } = order
  return project(safe)
}

function displayStatusWhere(status: z.infer<typeof listSchema>['status']) {
  if (!status) return {}
  if (status === 'DRAFT' || status === 'SUBMITTED' || status === 'CANCELLED') {
    return { status, fulfillment: { is: null } }
  }
  if (status === 'ACCEPTED') {
    return {
      status: 'ACCEPTED',
      fulfillment: { is: { purchaseOrder: { status: { in: ['DRAFT', 'SUBMITTED', 'CONFIRMED'] } } } },
    }
  }
  if (status === 'FULFILLING') {
    return {
      status: 'ACCEPTED',
      fulfillment: { is: { purchaseOrder: { status: { in: ['DELIVERING', 'PENDING_CONFIRM', 'RECEIVED'] } } } },
    }
  }
  if (status === 'COMPLETED') {
    return { status: 'ACCEPTED', fulfillment: { is: { purchaseOrder: { status: 'COMPLETED' } } } }
  }
  return {
    OR: [
      { status: 'ACCEPTED', OR: [{ fulfillment: { is: null } }, { fulfillment: { is: { purchaseOrder: { status: 'CANCELLED' } } } }] },
      { status: { in: ['DRAFT', 'SUBMITTED', 'CANCELLED'] }, fulfillment: { isNot: null } },
    ],
  }
}

export const replenishmentOrderRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { page, pageSize, status, storeId, supplierId } = parsed.data
    const where = readScope(req.user)
    Object.assign(where, displayStatusWhere(status))
    if (storeId) {
      if (where.storeId && !(where.storeId.in || []).includes(storeId)) return reply.status(403).send({ error: '无权查看该门店补货单' })
      where.storeId = storeId
    }
    if (supplierId) {
      if (typeof where.supplierId === 'string' && where.supplierId !== supplierId) return reply.status(403).send({ error: '无权查看该供应商补货单' })
      where.supplierId = supplierId
    }
    const [rows, total] = await Promise.all([
      prisma.replenishmentOrder.findMany({ where, select: detailSelect, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.replenishmentOrder.count({ where }),
    ])
    return { items: rows.map(project), total, page, pageSize }
  })

  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const order = await prisma.replenishmentOrder.findFirst({
      where: { ...readScope(req.user), id: req.params.id },
      select: detailSelect,
    })
    if (!order) return reply.status(404).send({ error: '补货单不存在或无权查看' })
    return project(order)
  })

  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!canWrite(req.user)) return reply.status(403).send({ error: '只有内部供应链可代门店新建补货单' })
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const input = parsed.data
    const { tenantId, userId, role } = req.user
    const fingerprint = createFingerprint(input)
    const replay = await prisma.replenishmentOrder.findFirst({
      where: { tenantId, createdById: userId, idempotencyKey: input.idempotencyKey },
      select: replaySelect,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) return reply.status(409).send({ error: '同一幂等键不能用于不同的补货请求' })
      return projectReplay(replay)
    }
    const [store, supplier, products] = await Promise.all([
      prisma.store.findFirst({ where: { id: input.storeId, tenantId, status: 'ENABLED' }, select: { id: true } }),
      prisma.supplier.findFirst({
        where: {
          id: input.supplierId,
          tenantId,
          status: 'ENABLED',
          OR: [{ businessScopes: { has: 'STORE_FULFILLER' } }, { sourceType: 'HEADQ_WAREHOUSE' }],
        },
        select: { id: true },
      }),
      loadOrderDraftProducts({ tenantId, supplierId: input.supplierId, productIds: input.items.map(item => item.productId) }),
    ])
    if (!store) return reply.status(400).send({ error: '门店不存在或已停用' })
    if (!supplier) return reply.status(400).send({ error: '供应商不在门店履约范围内' })
    const validation = validateOrderDraftLines(products, input.items)
    if (!validation.ok) return reply.status(400).send({ error: validation.issues[0]?.message || '补货明细校验失败' })
    const rows = itemRows(products, validation)
    let created: any
    try {
      created = await prisma.$transaction(async tx => {
        const ym = businessMonthKey()
        const latest = await tx.replenishmentOrder.findFirst({
          where: { tenantId, no: { startsWith: `RO${ym}` } },
          orderBy: { no: 'desc' },
          select: { no: true },
        })
        const no = await nextBusinessNo(tx, tenantId, 'RO', ym, 'RO', businessNoFloor(latest?.no, 'RO', ym))
        const order = await tx.replenishmentOrder.create({
          data: {
            tenantId,
            no,
            storeId: input.storeId,
            supplierId: input.supplierId,
            expectedDate: new Date(input.expectedDate),
            totalAmount: validation.totalAmount!,
            note: input.note || null,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            createdById: userId,
            items: { create: rows },
          },
          select: detailSelect,
        })
        await tx.replenishmentOrderEvent.create({
          data: {
            tenantId,
            replenishmentOrderId: order.id,
            eventType: 'CREATED',
            actorId: userId,
            actorRole: role,
            toStatus: 'DRAFT',
            requestId: req.id,
            ip: req.ip,
            metadata: { source: 'SUPPLY_CHAIN_PROXY', fingerprint },
          },
        })
        return order
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error: any) {
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const existing = await prisma.replenishmentOrder.findFirst({
          where: { tenantId, createdById: userId, idempotencyKey: input.idempotencyKey },
          select: replaySelect,
        })
        if (existing && existing.requestFingerprint === fingerprint) return projectReplay(existing)
        if (existing) return reply.status(409).send({ error: '同一幂等键不能用于不同的补货请求' })
        if (error?.code === 'P2034') return reply.status(409).send({ error: '补货单正在创建，请稍后重试' })
      }
      throw error
    }
    return reply.status(201).send(project(created))
  })

  app.patch('/:id', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!canWrite(req.user)) return reply.status(403).send({ error: '无权编辑补货单' })
    const parsed = editSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const input = parsed.data
    const { tenantId, userId, role } = req.user
    const fingerprint = editFingerprint(input)
    const replay = await prisma.replenishmentOrderEvent.findFirst({
      where: { tenantId, requestKey: input.requestKey },
      select: { replenishmentOrderId: true, eventType: true, metadata: true },
    })
    if (replay) {
      if (replay.replenishmentOrderId !== req.params.id || replay.eventType !== 'EDITED') {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的补货单操作' })
      }
      if ((replay.metadata as any)?.fingerprint !== fingerprint) {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的草稿编辑内容' })
      }
      const existing = await prisma.replenishmentOrder.findFirst({ where: { id: req.params.id, tenantId }, select: detailSelect })
      if (!existing) return reply.status(404).send({ error: '补货单不存在' })
      return project(existing)
    }
    const current = await prisma.replenishmentOrder.findFirst({
      where: { id: req.params.id, tenantId, status: 'DRAFT' },
      select: { id: true, rowVersion: true },
    })
    if (!current) return reply.status(409).send({ error: '只有草稿补货单可以编辑' })
    if (current.rowVersion !== input.rowVersion) return reply.status(409).send({ error: '补货单已更新，请刷新后重试' })
    const [store, supplier, products] = await Promise.all([
      prisma.store.findFirst({ where: { id: input.storeId, tenantId, status: 'ENABLED' }, select: { id: true } }),
      prisma.supplier.findFirst({
        where: {
          id: input.supplierId,
          tenantId,
          status: 'ENABLED',
          OR: [{ businessScopes: { has: 'STORE_FULFILLER' } }, { sourceType: 'HEADQ_WAREHOUSE' }],
        },
        select: { id: true },
      }),
      loadOrderDraftProducts({ tenantId, supplierId: input.supplierId, productIds: input.items.map(item => item.productId) }),
    ])
    if (!store) return reply.status(400).send({ error: '门店不存在或已停用' })
    if (!supplier) return reply.status(400).send({ error: '供应商不在门店履约范围内' })
    const validation = validateOrderDraftLines(products, input.items)
    if (!validation.ok) return reply.status(400).send({ error: validation.issues[0]?.message || '补货明细校验失败' })
    const rows = itemRows(products, validation)
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.replenishmentOrder.updateMany({
          where: { id: current.id, tenantId, status: 'DRAFT', rowVersion: input.rowVersion },
          data: {
            storeId: input.storeId,
            supplierId: input.supplierId,
            expectedDate: new Date(input.expectedDate),
            note: input.note || null,
            totalAmount: validation.totalAmount!,
            rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw Object.assign(new Error('补货单已更新，请刷新后重试'), { statusCode: 409 })
        await tx.replenishmentOrderItem.deleteMany({ where: { replenishmentOrderId: current.id } })
        await tx.replenishmentOrderItem.createMany({ data: rows.map(row => ({ tenantId, replenishmentOrderId: current.id, ...row })) })
        await tx.replenishmentOrderEvent.create({
          data: {
            tenantId,
            replenishmentOrderId: current.id,
            eventType: 'EDITED',
            actorId: userId,
            actorRole: role,
            fromStatus: 'DRAFT',
            toStatus: 'DRAFT',
            requestId: req.id,
            requestKey: input.requestKey,
            ip: req.ip,
            metadata: { fingerprint, rowVersion: input.rowVersion },
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error: any) {
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const committed = await prisma.replenishmentOrderEvent.findFirst({
          where: { tenantId, requestKey: input.requestKey, replenishmentOrderId: current.id, eventType: 'EDITED' },
          select: { metadata: true },
        })
        if (!committed) return reply.status(409).send({ error: '补货单正在被编辑，请刷新后重试' })
        if ((committed.metadata as any)?.fingerprint !== fingerprint) {
          return reply.status(409).send({ error: '同一幂等键不能用于不同的草稿编辑内容' })
        }
      } else throw error
    }
    const result = await prisma.replenishmentOrder.findFirst({ where: { id: current.id, tenantId }, select: detailSelect })
    return project(result)
  })

  app.post('/:id/submit', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!canWrite(req.user)) return reply.status(403).send({ error: '无权提交补货单' })
    const parsed = submitSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { tenantId, userId, role } = req.user
    const replay = await prisma.replenishmentOrderEvent.findFirst({
      where: { tenantId, requestKey: parsed.data.requestKey },
      select: { replenishmentOrderId: true, eventType: true },
    })
    if (replay) {
      if (replay.replenishmentOrderId !== req.params.id || replay.eventType !== 'SUBMITTED') {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的补货单操作' })
      }
      const existing = await prisma.replenishmentOrder.findFirst({ where: { id: req.params.id, tenantId }, select: detailSelect })
      if (!existing) return reply.status(404).send({ error: '补货单不存在' })
      return project(existing)
    }
    const current = await prisma.replenishmentOrder.findFirst({
      where: { id: req.params.id, tenantId, status: 'DRAFT' },
      include: { items: true },
    })
    if (!current) return reply.status(409).send({ error: '补货单不存在或状态已变化' })
    const inputLines = current.items.map(item => ({ productId: item.productId, quantity: Number(item.quantity) }))
    const products = await loadOrderDraftProducts({ tenantId, supplierId: current.supplierId, productIds: inputLines.map(item => item.productId) })
    const validation = validateOrderDraftLines(products, inputLines)
    if (!validation.ok) return reply.status(400).send({ error: validation.issues[0]?.message || '补货明细校验失败' })
    const rows = itemRows(products, validation)
    // 草稿保存时已经冻结单价。提交必须显式确认过新的价格，不能在用户点击
    // “提交”时静默重定价。若目录价格变化，要求用户回到草稿重新保存并复核。
    const frozenByProduct = new Map(current.items.map(item => [item.productId, item]))
    const priceChanges = rows.flatMap(row => {
      const frozen = frozenByProduct.get(row.productId)
      if (!frozen || new Prisma.Decimal(frozen.unitPrice).equals(row.unitPrice)) return []
      const oldPrice = new Prisma.Decimal(frozen.unitPrice)
      const newPrice = new Prisma.Decimal(row.unitPrice)
      return [{
        productId: row.productId,
        productName: row.productNameSnapshot,
        oldPrice: oldPrice.toFixed(2),
        newPrice: newPrice.toFixed(2),
        delta: newPrice.minus(oldPrice).toFixed(2),
      }]
    })
    if (priceChanges.length > 0) {
      return reply.status(409).send({
        error: '商品价格已变动，请核对价格差异并确认后再保存提交',
        code: 'REPLENISHMENT_PRICE_CHANGED',
        changedItems: priceChanges,
      })
    }
    await prisma.$transaction(async tx => {
      const updated = await tx.replenishmentOrder.updateMany({
        where: { id: current.id, tenantId, status: 'DRAFT', rowVersion: current.rowVersion },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedById: userId,
          totalAmount: validation.totalAmount!,
          rowVersion: { increment: 1 },
        },
      })
      if (updated.count !== 1) throw Object.assign(new Error('补货单状态已变化，请刷新后重试'), { statusCode: 409 })
      await tx.replenishmentOrderItem.deleteMany({ where: { replenishmentOrderId: current.id } })
      await tx.replenishmentOrderItem.createMany({
        data: rows.map(row => ({ tenantId, replenishmentOrderId: current.id, ...row })),
      })
      await tx.replenishmentOrderEvent.create({
        data: {
          tenantId,
          replenishmentOrderId: current.id,
          eventType: 'SUBMITTED',
          actorId: userId,
          actorRole: role,
          fromStatus: 'DRAFT',
          toStatus: 'SUBMITTED',
          requestId: req.id,
          requestKey: parsed.data.requestKey,
          ip: req.ip,
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    const result = await prisma.replenishmentOrder.findFirst({ where: { id: current.id, tenantId }, select: detailSelect })
    return project(result)
  })

  app.post('/:id/accept', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!canWrite(req.user)) return reply.status(403).send({ error: '无权接收补货单' })
    const parsed = acceptSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { tenantId, userId, role } = req.user
    try {
      const result = await prisma.$transaction(tx => acceptReplenishmentInTransaction(tx, {
        tenantId,
        replenishmentOrderId: req.params.id,
        actorId: userId,
        actorRole: role,
        requestId: req.id,
        requestKey: parsed.data.requestKey,
        ip: req.ip,
      }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
      return {
        replayed: result.replayed,
        replenishmentOrderId: req.params.id,
        purchaseOrderId: result.purchaseOrder.id,
        purchaseOrderNo: result.purchaseOrder.no,
      }
    } catch (error: any) {
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        const replay = await prisma.replenishmentOrderEvent.findFirst({
          where: { tenantId, requestKey: parsed.data.requestKey },
          select: { replenishmentOrderId: true },
        })
        if (replay?.replenishmentOrderId === req.params.id) {
          const link = await prisma.replenishmentFulfillmentLink.findUnique({
            where: { replenishmentOrderId: req.params.id },
            include: { purchaseOrder: { select: { id: true, no: true } } },
          })
          if (link) return {
            replayed: true,
            replenishmentOrderId: req.params.id,
            purchaseOrderId: link.purchaseOrder.id,
            purchaseOrderNo: link.purchaseOrder.no,
          }
        }
        return reply.status(409).send({ error: '补货单正在被处理，请刷新后重试' })
      }
      throw error
    }
  })

  app.post('/:id/cancel', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!canWrite(req.user)) return reply.status(403).send({ error: '无权取消补货单' })
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { tenantId, userId, role } = req.user
    const cancelFingerprint = hashRequestBody({ replenishmentOrderId: req.params.id, reason: parsed.data.reason }, 'replenishment-order-cancel')
    const replay = await prisma.replenishmentOrderEvent.findFirst({
      where: { tenantId, requestKey: parsed.data.requestKey },
      select: { replenishmentOrderId: true, eventType: true, metadata: true },
    })
    if (replay) {
      if (replay.replenishmentOrderId !== req.params.id || replay.eventType !== 'CANCELLED') {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的补货单操作' })
      }
      if ((replay.metadata as any)?.fingerprint !== cancelFingerprint) {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的取消原因' })
      }
      return { success: true, replayed: true }
    }
    const current = await prisma.replenishmentOrder.findFirst({
      where: { id: req.params.id, tenantId },
      include: { fulfillment: true },
    })
    if (!current || !['DRAFT', 'SUBMITTED'].includes(current.status) || current.fulfillment) {
      return reply.status(409).send({ error: '补货单已开始履约，不能直接取消' })
    }
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.replenishmentOrder.updateMany({
          where: { id: current.id, tenantId, status: current.status, rowVersion: current.rowVersion },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledById: userId,
            cancelReason: parsed.data.reason,
            rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw Object.assign(new Error('补货单状态已变化，请刷新后重试'), { statusCode: 409 })
        await tx.replenishmentOrderEvent.create({
          data: {
            tenantId,
            replenishmentOrderId: current.id,
            eventType: 'CANCELLED',
            actorId: userId,
            actorRole: role,
            fromStatus: current.status,
            toStatus: 'CANCELLED',
            requestId: req.id,
            requestKey: parsed.data.requestKey,
            ip: req.ip,
            metadata: { reason: parsed.data.reason, fingerprint: cancelFingerprint },
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error: any) {
      if (error?.code !== 'P2002' && error?.code !== 'P2034') throw error
      const committed = await prisma.replenishmentOrderEvent.findFirst({
        where: { tenantId, requestKey: parsed.data.requestKey, replenishmentOrderId: current.id, eventType: 'CANCELLED' },
        select: { metadata: true },
      })
      if (!committed) return reply.status(409).send({ error: '补货单正在被取消，请刷新后重试' })
      if ((committed.metadata as any)?.fingerprint !== cancelFingerprint) {
        return reply.status(409).send({ error: '同一幂等键不能用于不同的取消原因' })
      }
    }
    return { success: true }
  })
}
