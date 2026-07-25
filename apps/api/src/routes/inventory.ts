import { randomUUID } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'
import { isStoreScoped } from '../lib/auth-scope'
import { hasInternalSupplyChainCapability } from '../lib/internal-supply-chain-access'
import { buildIdempotencyKey } from '../lib/idempotency'
import { estimatedStoreInventory, latestStoreInventorySnapshot } from '../services/storeInventory'
import { resolveProductInventoryUnit } from '../services/inventoryUnits'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const INVENTORY_VIEW_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
const INVENTORY_WRITE_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF'])
const INVENTORY_POLICY_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])

function canViewInventory(role: string | undefined | null) {
  return Boolean(role && (
    INVENTORY_VIEW_ROLES.has(role)
    || hasInternalSupplyChainCapability(role, 'inventory.read')
  ))
}

const consumeSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
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

const inventoryPolicySchema = z.object({
  storeId: z.string().min(1).optional(),
  minStock: z.number().min(0).max(1_000_000_000),
  targetStock: z.number().min(0).max(1_000_000_000).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.targetStock != null && value.targetStock < value.minStock) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetStock'], message: '目标库存不能低于安全库存' })
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
    if (!canViewInventory(req.user.role)) return reply.status(403).send({ error: '无权查看门店库存' })
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
    if (!canViewInventory(req.user.role)) return reply.status(403).send({ error: '无权查看门店库存' })
    try {
      const storeId = await resolveInventoryStore(req.user, req.query?.storeId)
      const estimate = await estimatedStoreInventory(req.user.tenantId, storeId)
      return estimate.items
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
  })

  // 多门店必须各自维护补货阈值；数量统一使用当前 SKU 的库存基础单位。
  app.patch('/policies/:productId', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!INVENTORY_POLICY_ROLES.has(role)) return reply.status(403).send({ error: '无权设置门店库存策略' })
    const parsed = inventoryPolicySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    let storeId: string
    try {
      storeId = await resolveInventoryStore(req.user, parsed.data.storeId)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, tenantId },
      select: { id: true, name: true, unit: true, inventoryUnit: true },
    })
    if (!product) return reply.status(404).send({ error: '原材料不存在' })
    const result = await prisma.$transaction(async tx => {
      const policy = await tx.storeInventoryPolicy.upsert({
        where: { storeId_productId: { storeId, productId: product.id } },
        update: { minStock: parsed.data.minStock, targetStock: parsed.data.targetStock ?? null },
        create: {
          tenantId, storeId, productId: product.id,
          minStock: parsed.data.minStock, targetStock: parsed.data.targetStock ?? null,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `设置门店安全库存 ${product.name} ${parsed.data.minStock}${product.inventoryUnit || product.unit}`,
          entityType: 'StoreInventoryPolicy', targetId: policy.id, target: product.name,
          metadata: { storeId, productId: product.id, ...parsed.data },
        },
      })
      return policy
    })
    return {
      id: result.id, productId: result.productId, storeId: result.storeId,
      minStock: Number(result.minStock),
      targetStock: result.targetStock == null ? null : Number(result.targetStock),
      unit: product.inventoryUnit || product.unit,
    }
  })

  // 人工补录食材消耗。一次请求中的全部明细和审计日志原子提交。
  app.post('/consume', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!INVENTORY_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权录入门店消耗' })
    if (!storeId) return reply.status(400).send({ error: '当前账号未绑定门店' })
    const parsed = consumeSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { items, note, idempotencyKey } = parsed.data
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
      prisma.product.findMany({
        where: { tenantId, id: { in: items.map(item => item.productId) } },
        select: {
          id: true, name: true, unit: true, inventoryUnit: true,
          inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
        },
      }),
    ])
    if (!store) return reply.status(400).send({ error: '绑定门店不存在或不属于当前租户' })
    if (products.length !== items.length) return reply.status(400).send({ error: '存在不属于当前租户的食材' })
    const productById = new Map(products.map(product => [product.id, product]))
    const pendingProduct = products.find(product => {
      const contract = resolveProductInventoryUnit(product)
      return !contract.structured || contract.status === 'PENDING'
    })
    if (pendingProduct) return reply.status(409).send({ error: `原材料“${pendingProduct.name}”库存单位尚未核验` })

    const operationId = idempotencyKey
      ? buildIdempotencyKey({
          tenantId, userId, method: 'POST', url: '/api/inventory/consume', clientKey: idempotencyKey,
        })
      : randomUUID()
    const result = await prisma.$transaction(async tx => {
      if (idempotencyKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory-consume:${operationId}`}))`
        const existing = await tx.stockConsumption.findMany({
          where: { tenantId, storeId, createdById: userId, sourceType: 'manual', sourceId: operationId, voidedAt: null },
          select: { productId: true, quantity: true, inventoryQuantity: true, date: true, note: true },
        })
        if (existing.length > 0) {
          const requested = new Map(items.map(item => [item.productId, item.quantity]))
          const sameRequest = existing.length === items.length && existing.every(row =>
            row.date.toISOString().slice(0, 10) === dateText
            && (row.note || null) === (note || null)
            && requested.has(row.productId)
            && new Prisma.Decimal(requested.get(row.productId)!).equals(row.inventoryQuantity ?? row.quantity),
          )
          if (!sameRequest) {
            throw Object.assign(new Error('同一幂等键不能用于不同的领用内容'), { statusCode: 409 })
          }
          return { count: existing.length, duplicated: true }
        }
      }
      await tx.stockConsumption.createMany({
        data: items.map(item => {
          const contract = resolveProductInventoryUnit(productById.get(item.productId)!)
          return {
          tenantId,
          storeId,
          productId: item.productId,
          quantity: new Prisma.Decimal(item.quantity),
          unitSnapshot: contract.inventoryUnit,
          inventoryQuantity: new Prisma.Decimal(item.quantity),
          inventoryUnitSnapshot: contract.inventoryUnit,
          date: consumeDate,
          note: note || null,
          sourceType: 'manual',
          sourceId: operationId,
          createdById: userId,
          }
        }),
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
      return { count: items.length, duplicated: false }
    })

    await revalueStoreConsumptionCosts(tenantId, storeId).catch(error => {
      req.log.error({ error, storeId }, 'manual inventory consumption cost snapshot refresh failed')
    })

    return { success: true, count: result.count, operationId, duplicated: result.duplicated }
  })

  app.get('/consumptions', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId: boundStoreId } = req.user
    if (!canViewInventory(role)) return reply.status(403).send({ error: '无权查看门店消耗' })
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
      where: { tenantId, date: { gte: since }, voidedAt: null, ...(storeId ? { storeId } : {}) },
      include: {
        product: { select: { name: true, unit: true, spec: true, code: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
  })
}
