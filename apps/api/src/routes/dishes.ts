/**
 * 菜品 BOM 路由
 *  - 菜品 CRUD (总厨/管理层)
 *  - 配方 CRUD (总厨)
 *  - 销量录入 (店长/POS 接入)
 *  - 毛利计算 = (salePrice - food_cost_from_recipe) / salePrice
 *  - 销量榜 / 食材消耗推算
 */
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import dayjs from 'dayjs'
import { monthRangeForDateCol } from '../lib/dateRange'
import { isStoreScoped } from '../lib/auth-scope'

const CHEF_ROLES = ['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN']
const VIEW_ROLES = [...CHEF_ROLES, 'FINANCE', 'MANAGER', 'KITCHEN_LEAD']
const SALE_WRITE_ROLES = ['MANAGER', 'KITCHEN_LEAD', ...CHEF_ROLES]
const auth = (app: any) => ({ preHandler: [app.authenticate] })

const dishSchema = z.object({
  name:        z.string().min(1).max(60),
  code:        z.string().max(40).optional(),
  category:    z.string().max(40).optional(),
  unit:        z.string().max(10).optional().default('份'),
  salePrice:   z.number().nonnegative(),
  imageUrl:    z.string().optional(),
  description: z.string().max(500).optional(),
  groupWide:   z.boolean().optional().default(true),
  storeIds:    z.array(z.string()).optional().default([]),
  status:      z.enum(['ACTIVE', 'DISABLED', 'UPCOMING']).optional().default('ACTIVE'),
})

const recipeSchema = z.object({
  productId: z.string().min(1),
  quantity:  z.number().positive(),
  unit:      z.string().min(1),
  lossRate:  z.number().min(0).max(1).optional().default(0),
  isMain:    z.boolean().optional().default(false),
  note:      z.string().max(100).optional(),
})

const saleSchema = z.object({
  storeId:     z.string().min(1),
  dishId:      z.string().min(1),
  date:        z.string(),
  quantity:    z.number().nonnegative(),
  grossAmount: z.number().nonnegative(),
  source:      z.literal('manual').optional().default('manual'),
  channel:     z.string().optional(),
})

function dateOnly(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (
    parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() !== Number(match[2]) - 1
    || parsed.getUTCDate() !== Number(match[3])
  ) return null
  return parsed
}

function scopedStoreId(user: any, requestedStoreId?: string) {
  if (!isStoreScoped(user.role)) return requestedStoreId || null
  if (!user.storeId) throw Object.assign(new Error('当前账号没有绑定门店'), { statusCode: 403 })
  if (requestedStoreId && requestedStoreId !== user.storeId) {
    throw Object.assign(new Error('只能操作当前账号绑定的门店'), { statusCode: 403 })
  }
  return user.storeId
}

/** 算菜品的食材成本 (基于当前配方 + Product.price) */
async function calcDishCost(dishId: string): Promise<number> {
  const recipes = await prisma.dishRecipe.findMany({
    where: { dishId, variantKey: '' },
    include: { product: { select: { price: true } } },
  })
  let cost = 0
  for (const r of recipes) {
    const unitPrice = Number(r.product?.price || 0)
    const qty = Number(r.quantity) * (1 + Number(r.lossRate))   // 算上损耗
    cost += unitPrice * qty
  }
  return Math.round(cost * 100) / 100
}

export const dishRoutes: FastifyPluginAsync = async (app) => {

  // ── 菜品列表 ──────────────────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { status, category, withCost } = req.query as any
    const where: any = { tenantId }
    if (status) where.status = status
    if (category && category !== 'all') where.category = category
    const dishes = await prisma.dish.findMany({
      where, orderBy: [{ status: 'asc' }, { category: 'asc' }, { name: 'asc' }],
      include: {
        recipes: withCost === '1' ? {
          where: { variantKey: '' },
          include: { product: { select: { name: true, unit: true, price: true, spec: true } } },
        } : false,
      },
    })
    if (withCost === '1') {
      const enriched = dishes.map((d: any) => {
        let cost = 0
        for (const r of d.recipes || []) {
          cost += Number(r.product?.price || 0) * Number(r.quantity) * (1 + Number(r.lossRate))
        }
        cost = Math.round(cost * 100) / 100
        const sale = Number(d.salePrice)
        const grossProfit = sale - cost
        const grossMargin = sale > 0 ? grossProfit / sale : 0
        return { ...d, foodCost: cost, grossProfit, grossMargin }
      })
      return reply.send(enriched)
    }
    return reply.send(dishes)
  })

  // ── 菜品详情 ──────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const d = await prisma.dish.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        recipes: {
          include: { product: { select: { id: true, name: true, unit: true, price: true, spec: true, supplier: { select: { name: true } } } } },
        },
      },
    })
    if (!d) return reply.status(404).send({ error: '菜品不存在' })
    const cost = await calcDishCost(d.id)
    return reply.send({
      ...d, foodCost: cost,
      grossProfit: Number(d.salePrice) - cost,
      grossMargin: Number(d.salePrice) > 0 ? (Number(d.salePrice) - cost) / Number(d.salePrice) : 0,
    })
  })

  // ── 创建菜品 (总厨) ───────────────────────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可建菜品' })
    const parsed = dishSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const d = parsed.data
    const created = await prisma.dish.create({
      data: {
        tenantId, name: d.name, code: d.code,
        category: d.category, unit: d.unit, salePrice: d.salePrice,
        imageUrl: d.imageUrl, description: d.description,
        groupWide: d.groupWide, storeIds: d.storeIds,
        status: d.status as any, createdById: userId,
      },
    })
    return reply.status(201).send(created)
  })

  // ── 更新菜品 ──────────────────────────────────────
  app.put('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const parsed = dishSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const r = await prisma.dish.updateMany({
      where: { id: req.params.id, tenantId },
      data: parsed.data as any,
    })
    if (r.count === 0) return reply.status(404).send({ error: '菜品不存在' })
    return prisma.dish.findUnique({ where: { id: req.params.id } })
  })

  // ── 删除菜品 (软删 — 改 status 即可) ─────────────
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    // 有销量记录 → 不能硬删, 仅改 DISABLED
    const hasSales = await prisma.dishSale.count({ where: { dishId: req.params.id } })
    if (hasSales > 0) {
      await prisma.dish.updateMany({
        where: { id: req.params.id, tenantId }, data: { status: 'DISABLED' },
      })
      return { ok: true, mode: 'disabled', reason: `有 ${hasSales} 条销量记录, 仅停用` }
    }
    const r = await prisma.dish.deleteMany({ where: { id: req.params.id, tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: '菜品不存在' })
    return { ok: true, mode: 'deleted' }
  })

  // ── 配方 CRUD ─────────────────────────────────────
  app.get('/:id/recipes', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const dish = await prisma.dish.findFirst({ where: { id: req.params.id, tenantId } })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    return prisma.dishRecipe.findMany({
      where: { dishId: req.params.id },
      include: { product: { select: { id: true, name: true, unit: true, price: true, code: true, spec: true } } },
      orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
    })
  })

  app.post('/:id/recipes', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨可改配方' })
    const dish = await prisma.dish.findFirst({ where: { id: req.params.id, tenantId } })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    const parsed = recipeSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    // 校验 product 是否属于本 tenant
    const product = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId } })
    if (!product) return reply.status(400).send({ error: '食材 SKU 不存在' })
    if (parsed.data.unit !== product.unit) {
      return reply.status(400).send({ error: `配方单位必须与食材库存单位一致（${product.unit}）` })
    }
    try {
      const r = await prisma.dishRecipe.create({
        data: { dishId: req.params.id, ...parsed.data },
      })
      return reply.status(201).send(r)
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.status(400).send({ error: '该 SKU 已在配方中' })
      throw e
    }
  })

  app.put('/recipes/:rid', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const parsed = recipeSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    // 校验 recipe 归属(经 dishId → dish.tenantId)
    const recipe = await prisma.dishRecipe.findUnique({
      where: { id: req.params.rid },
      include: { dish: { select: { tenantId: true } }, product: { select: { id: true, tenantId: true, unit: true } } },
    })
    if (!recipe || recipe.dish.tenantId !== tenantId) return reply.status(404).send({ error: '配方不存在' })
    const product = parsed.data.productId && parsed.data.productId !== recipe.productId
      ? await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId }, select: { id: true, unit: true } })
      : recipe.product
    if (!product || (product as any).tenantId && (product as any).tenantId !== tenantId) {
      return reply.status(400).send({ error: '食材 SKU 不存在' })
    }
    const nextUnit = parsed.data.unit || recipe.unit
    if (nextUnit !== product.unit) {
      return reply.status(400).send({ error: `配方单位必须与食材库存单位一致（${product.unit}）` })
    }
    const r = await prisma.dishRecipe.update({ where: { id: req.params.rid }, data: parsed.data })
    return r
  })

  app.delete('/recipes/:rid', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const recipe = await prisma.dishRecipe.findUnique({
      where: { id: req.params.rid },
      include: { dish: { select: { tenantId: true } } },
    })
    if (!recipe || recipe.dish.tenantId !== tenantId) return reply.status(404).send({ error: '配方不存在' })
    await prisma.dishRecipe.delete({ where: { id: req.params.rid } })
    return { ok: true }
  })

  // ── 销量 ──────────────────────────────────────────
  app.get('/sales', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { from, to, storeId: qStore } = req.query as any
    const where: any = { tenantId }
    if (from || to) {
      where.date = {}
      if (from) where.date.gte = new Date(from)
      if (to) where.date.lte = new Date(to)
    }
    try {
      const targetStoreId = scopedStoreId(req.user, qStore)
      if (targetStoreId) where.storeId = targetStoreId
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({ error: error.message })
    }
    return prisma.dishSale.findMany({
      where, orderBy: { date: 'desc' }, take: 500,
      include: { dish: { select: { name: true, salePrice: true } }, store: { select: { name: true } } },
    })
  })

  app.post('/sales', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!SALE_WRITE_ROLES.includes(role)) {
      return reply.status(403).send({ error: '无权录入销量' })
    }
    const parsed = saleSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const d = parsed.data
    const saleDate = dateOnly(d.date)
    if (!saleDate) return reply.status(400).send({ error: '营业日期格式错误，请使用 YYYY-MM-DD' })
    try {
      scopedStoreId(req.user, d.storeId)
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({ error: error.message })
    }
    const [store, dish] = await Promise.all([
      prisma.store.findFirst({ where: { id: d.storeId, tenantId }, select: { id: true } }),
      prisma.dish.findFirst({ where: { id: d.dishId, tenantId }, select: { id: true, inventoryPolicy: true } }),
    ])
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })

    const sale = await prisma.$transaction(async tx => {
      const saleLock = `dish-sale:${tenantId}:${d.storeId}:${d.dishId}:${d.date}`
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${saleLock}))`)
      const unique = {
        storeId: d.storeId, dishId: d.dishId, date: saleDate, source: d.source,
      }
      const wasUpdate = await tx.dishSale.findUnique({ where: { storeId_dishId_date_source: unique } })
      const saved = await tx.dishSale.upsert({
        where: { storeId_dishId_date_source: unique },
        update: { quantity: d.quantity, grossAmount: d.grossAmount, channel: d.channel },
        create: {
          tenantId, storeId: d.storeId, dishId: d.dishId,
          date: saleDate, quantity: d.quantity, grossAmount: d.grossAmount,
          source: d.source, channel: d.channel, createdById: userId,
        },
      })
      const qtyChanged = !wasUpdate || Math.abs(Number(wasUpdate.quantity) - Number(d.quantity)) > 0.001
      if (!qtyChanged) return saved
      await tx.stockConsumption.deleteMany({ where: { sourceType: 'dish_sale', sourceId: saved.id } })
      if (dish.inventoryPolicy === 'EXCLUDE') return saved
      const recipes = await tx.dishRecipe.findMany({
        where: { dishId: d.dishId, variantKey: '' },
        select: { productId: true, quantity: true, lossRate: true },
      })
      const consumptions = recipes.flatMap(recipe => {
        const need = Number(d.quantity) * Number(recipe.quantity) * (1 + Number(recipe.lossRate))
        if (need <= 0) return []
        return [{
          tenantId, storeId: d.storeId, productId: recipe.productId, date: saleDate,
          quantity: new Prisma.Decimal(need.toFixed(6)), note: `菜品销售 ${d.quantity} 份`,
          sourceType: 'dish_sale', sourceId: saved.id, createdById: userId,
        }]
      })
      if (consumptions.length > 0) await tx.stockConsumption.createMany({ data: consumptions })
      return saved
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 })
    return sale
  })

  // ── 销量榜 (单月/单店或集团) ───────────────────────
  app.get('/sales-rank', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { month, storeId, limit = '20' } = req.query as any
    const ym = month || dayjs().format('YYYY-MM')
    // DishSale.date 是 PG DATE 列, 用 UTC 边界防 timezone 跨日
    const { start, end } = monthRangeForDateCol(ym)
    const where: any = { tenantId, date: { gte: start, lte: end } }
    try {
      const targetStoreId = scopedStoreId(req.user, storeId)
      if (targetStoreId) where.storeId = targetStoreId
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({ error: error.message })
    }
    const rows = await prisma.dishSale.groupBy({
      by: ['dishId'],
      where,
      _sum: { quantity: true, grossAmount: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: Math.min(100, parseInt(limit)),
    })
    if (rows.length === 0) return []
    const dishes = await prisma.dish.findMany({
      where: { id: { in: rows.map(r => r.dishId) } },
      include: {
        recipes: {
          where: { variantKey: '' },
          include: { product: { select: { price: true } } },
        },
      },
    })
    const dishMap = new Map(dishes.map(d => [d.id, d]))
    return rows.map(r => {
      const d = dishMap.get(r.dishId) as any
      if (!d) return null
      const recipes = d.recipes || []
      const unitCost = recipes.reduce((s: number, x: any) =>
        s + Number(x.product?.price || 0) * Number(x.quantity) * (1 + Number(x.lossRate)), 0)
      const qty = Number(r._sum.quantity || 0)
      const gross = Number(r._sum.grossAmount || 0)
      const totalCost = unitCost * qty
      return {
        dishId: d.id, name: d.name, category: d.category,
        salePrice: Number(d.salePrice),
        unitCost: Math.round(unitCost * 100) / 100,
        qty, gross,
        totalCost: Math.round(totalCost * 100) / 100,
        grossProfit: Math.round((gross - totalCost) * 100) / 100,
        grossMargin: gross > 0 ? (gross - totalCost) / gross : 0,
      }
    }).filter(Boolean)
  })

  // ── 食材消耗推算 (基于 销量 × BOM) ──────────────
  // GET /api/dishes/projected-consumption?from=&to=&storeId=
  app.get('/projected-consumption', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { from, to, storeId } = req.query as any
    const where: any = { tenantId }
    if (from || to) {
      where.date = {}
      if (from) where.date.gte = new Date(from)
      if (to) where.date.lte = new Date(to)
    }
    try {
      const targetStoreId = scopedStoreId(req.user, storeId)
      if (targetStoreId) where.storeId = targetStoreId
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({ error: error.message })
    }

    const sales = await prisma.dishSale.findMany({
      where,
      select: { dishId: true, quantity: true },
    })
    if (sales.length === 0) return []

    // group by dish
    const dishQty = new Map<string, number>()
    for (const s of sales) {
      dishQty.set(s.dishId, (dishQty.get(s.dishId) || 0) + Number(s.quantity))
    }

    const recipes = await prisma.dishRecipe.findMany({
      // 汇总销量没有规格维度，只以默认 BOM 做估算；实际日报库存扣减使用规格明细。
      where: { dishId: { in: Array.from(dishQty.keys()) }, variantKey: '' },
      include: { product: { select: { id: true, name: true, unit: true, spec: true } } },
    })

    // 按 productId 聚合消耗
    const consumed = new Map<string, { name: string; unit: string; qty: number }>()
    for (const r of recipes) {
      const dishSold = dishQty.get(r.dishId) || 0
      const need = dishSold * Number(r.quantity) * (1 + Number(r.lossRate))
      const cur = consumed.get(r.productId) || {
        name: r.product?.name || '?', unit: r.product?.unit || '', qty: 0,
      }
      cur.qty += need
      consumed.set(r.productId, cur)
    }

    return Array.from(consumed.entries()).map(([productId, v]) => ({
      productId, ...v,
      qty: Math.round(v.qty * 1000) / 1000,
    })).sort((a, b) => b.qty - a.qty)
  })
}
