import { randomUUID } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'
import { isStoreScoped } from '../lib/auth-scope'
import { estimatedStoreInventory, latestStoreInventorySnapshot } from '../services/storeInventory'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const INVENTORY_VIEW_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
const INVENTORY_WRITE_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF'])

const consumeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional(),
  note: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().positive().max(1_000_000).refine(
      value => new Prisma.Decimal(value).decimalPlaces() <= 6,
      '数量最多保留 6 位小数',
    ),
  }).strict()).min(1, '请填写消耗明细').max(500),
}).strict().superRefine((value, ctx) => {
  const ids = value.items.map(item => item.productId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '同一食材不能重复提交' })
  }
})

function strictDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('日期无效'), { statusCode: 400 })
  }
  return parsed
}

function chinaToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function resolveInventoryStore(user: any, requestedStoreId?: string | null) {
  const storeId = isStoreScoped(user.role) ? user.storeId : (requestedStoreId || user.storeId)
  if (!storeId) throw Object.assign(new Error('当前账号未绑定或未选择门店'), { statusCode: 400 })
  const store = await prisma.store.findFirst({ where: { id: storeId, tenantId: user.tenantId }, select: { id: true } })
  if (!store) throw Object.assign(new Error('门店不存在或不属于当前租户'), { statusCode: 404 })
  return store.id
}

export const inventoryRoutes: FastifyPluginAsync = async app => {
  app.get('/snapshot/latest', auth(app), async (req: any, reply) => {
    if (!INVENTORY_VIEW_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看门店库存' })
    try {
      const storeId = await resolveInventoryStore(req.user, req.query?.storeId)
      return latestStoreInventorySnapshot(req.user.tenantId, storeId, true)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
  })

  // 门店预计库存：最近实物盘点 + 后续实收入库 - BOM/人工消耗 - 店内报损。
  // Product.stock 属于供应商库存，绝不能在这里作为门店库存使用。
  app.get('/', auth(app), async (req: any, reply) => {
    if (!INVENTORY_VIEW_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看门店库存' })
    try {
      const storeId = await resolveInventoryStore(req.user, req.query?.storeId)
      const estimate = await estimatedStoreInventory(req.user.tenantId, storeId)
      return estimate.items
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
  })

  // 人工补录食材消耗。一次请求中的全部明细和审计日志原子提交。
  app.post('/consume', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!INVENTORY_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权录入门店消耗' })
    if (!storeId) return reply.status(400).send({ error: '当前账号未绑定门店' })
    const parsed = consumeSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, note } = parsed.data
    const dateText = parsed.data.date || chinaToday()
    let consumeDate: Date
    try {
      consumeDate = strictDate(dateText)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
    if (dateText > chinaToday()) return reply.status(400).send({ error: '不能录入未来日期的消耗' })

    const [store, products] = await Promise.all([
      prisma.store.findFirst({ where: { id: storeId, tenantId }, select: { id: true } }),
      prisma.product.findMany({ where: { tenantId, id: { in: items.map(item => item.productId) } }, select: { id: true } }),
    ])
    if (!store) return reply.status(400).send({ error: '绑定门店不存在或不属于当前租户' })
    if (products.length !== items.length) return reply.status(400).send({ error: '存在不属于当前租户的食材' })

    const operationId = randomUUID()
    await prisma.$transaction(async tx => {
      await tx.stockConsumption.createMany({
        data: items.map(item => ({
          tenantId,
          storeId,
          productId: item.productId,
          quantity: new Prisma.Decimal(item.quantity),
          date: consumeDate,
          note: note || null,
          sourceType: 'manual',
          sourceId: operationId,
          createdById: userId,
        })),
      })
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: `录入消耗 ${items.length} 种食材，日期 ${dateText}`,
          entityType: 'StockConsumptionBatch',
          targetId: operationId,
          metadata: { storeId, date: dateText, itemCount: items.length },
        },
      })
    })

    return { success: true, count: items.length, operationId }
  })

  app.get('/consumptions', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId: boundStoreId } = req.user
    if (!INVENTORY_VIEW_ROLES.has(role)) return reply.status(403).send({ error: '无权查看门店消耗' })
    const query = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      storeId: z.string().optional(),
    }).safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })

    let storeId: string | undefined
    if (isStoreScoped(role)) {
      if (!boundStoreId) return reply.status(400).send({ error: '当前账号未绑定门店' })
      storeId = boundStoreId
    } else if (query.data.storeId) {
      const store = await prisma.store.findFirst({ where: { id: query.data.storeId, tenantId }, select: { id: true } })
      if (!store) return reply.status(404).send({ error: '门店不存在或不属于当前租户' })
      storeId = store.id
    }
    const since = dayjs().subtract(query.data.days, 'day').toDate()

    return prisma.stockConsumption.findMany({
      where: { tenantId, date: { gte: since }, ...(storeId ? { storeId } : {}) },
      include: {
        product: { select: { name: true, unit: true, spec: true, code: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
  })
}
