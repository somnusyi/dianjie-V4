import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isStoreScoped, isSupplierRole, resolveActiveStore } from '../lib/auth-scope'
import { requireSupplierCapability } from '../lib/supplier-access'
import { allowsSupplyDataRead, hasInternalSupplyChainCapability, supplyDataReadScope } from '../lib/internal-supply-chain-access'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'
import { calendarDateSchema } from '../lib/calendar-date'
import {
  addDeliveryItemInTransaction,
  changeDeliveryItemQuantityInTransaction,
  removeDeliveryItemInTransaction,
} from '../services/deliveryItemRemoval'

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

const deliveryItemQuantitySchema = z.coerce.number()
  .positive('新增商品数量必须大于 0')
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

export const deliveryRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { role, supplierId: actorSupplierId } = req.user
    if (!allowsSupplyDataRead(role, 'delivery.read')) {
      return reply.status(403).send({ error: '无权查看配送单' })
    }
    const q = parsed.data
    const where: any = supplyDataReadScope(req.user)
    if (q.storeId) {
      // 门店级角色指定门店时必须在可访问集合内（越权抛 403），非门店级按传入过滤
      if (isStoreScoped(role)) resolveActiveStore(req.user, q.storeId)
      where.storeId = q.storeId
    }
    if (isSupplierRole(role)) where.supplierId = requireSupplierCapability(role, actorSupplierId, 'order.read')
    else if (q.supplierId) where.supplierId = q.supplierId
    if (q.status) where.status = q.status
    const and: any[] = []
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
    if (and.length) where.AND = and
    if (q.dateFrom || q.dateTo) {
      where.createdAt = {
        ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00+08:00`) } : {}),
        ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59.999+08:00`) } : {}),
      }
    }
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
    return {
      items: items.map(delivery => ({
        ...delivery,
        items: delivery.items.map(withDocumentProductSnapshot),
      })),
      total, page: q.page, pageSize: q.pageSize,
    }
  })

  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { role, supplierId } = req.user
    if (!allowsSupplyDataRead(role, 'delivery.read')) {
      throw { statusCode: 403, message: '无权查看配送单' }
    }
    const where: any = { id: req.params.id, ...supplyDataReadScope(req.user) }
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
    return {
      ...delivery,
      items: delivery.items.map(withDocumentProductSnapshot),
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
      where: { id: String(req.params.id), tenantId },
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
      return await prisma.$transaction(async tx => {
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
        const positiveItemCount = await tx.deliveryOrderItem.count({
          where: {
            deliveryOrderId: String(req.params.id),
            removedAt: null,
            shippedQty: { gt: new Prisma.Decimal(0) },
          },
        })
        if (positiveItemCount === 0) {
          throw Object.assign(new Error('配送单至少保留一条数量大于 0 的商品'), { statusCode: 400 })
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
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 60_000,
      })
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
      return await prisma.$transaction(tx => changeDeliveryItemQuantityInTransaction(tx, {
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
      }), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      })
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
      return await prisma.$transaction(tx => addDeliveryItemInTransaction(tx, {
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
      }), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      })
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
      return await prisma.$transaction(tx => removeDeliveryItemInTransaction(tx, {
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
      }), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 20_000,
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })
}
