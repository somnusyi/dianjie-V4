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
import { parseBoundedInteger } from '../lib/pagination'
import { normalizeDishName, normalizeVariantKey } from '../services/dailyBusinessImport'
import { bomCalculationSnapshot, bomDateRangesOverlap, calculateBomConsumptions, isBomVersionEffective, selectEffectiveBomVersion } from '../services/bomLifecycle'
import { resolveProductInventoryUnit } from '../services/inventoryUnits'
import { convertQuantityToInventoryUnit } from '../services/inventoryUnits'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'

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
  variantKey: z.string().max(80).optional().default(''),
  quantity:  z.number().positive(),
  unit:      z.string().min(1),
  lossRate:  z.number().min(0).max(1).optional().default(0),
  isMain:    z.boolean().optional().default(false),
  note:      z.string().max(100).optional(),
})

const aliasSchema = z.object({
  rawName: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(32).optional().default('daily_pos'),
})

const bomDraftSchema = z.object({
  variantKey: z.string().max(80).optional().default(''),
  cloneFromVersionId: z.string().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  changeType: z.enum(['INITIAL', 'BUSINESS_CHANGE', 'HISTORICAL_CORRECTION']).optional().default('BUSINESS_CHANGE'),
  changeReason: z.string().trim().min(2).max(500),
})

const bomItemsSchema = z.object({
  items: z.array(recipeSchema.omit({ variantKey: true })).max(100),
})

const bomPublishSchema = z.object({
  confirmHistoricalCorrection: z.boolean().optional().default(false),
})

const lifecycleSchema = z.object({
  action: z.enum(['PUBLISH', 'DELIST', 'RELIST']),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupWide: z.boolean().optional().default(true),
  storeIds: z.array(z.string()).optional().default([]),
  reason: z.string().trim().min(2).max(300),
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

function dateText(value: Date) {
  return value.toISOString().slice(0, 10)
}

function utcDayBefore(value: Date) {
  const copy = new Date(value)
  copy.setUTCDate(copy.getUTCDate() - 1)
  return copy
}

function chinaDateText(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function effectiveDishStatus(dish: { status: string; availableFrom: Date | null; availableTo: Date | null }, onDate = chinaDateText()) {
  const from = dish.availableFrom ? dateText(dish.availableFrom) : null
  const to = dish.availableTo ? dateText(dish.availableTo) : null
  if (to && onDate >= to) return 'DISABLED'
  if (from && onDate < from) return 'UPCOMING'
  if (from && onDate >= from) return 'ACTIVE'
  return dish.status
}

function scopedStoreId(user: any, requestedStoreId?: string) {
  if (!isStoreScoped(user.role)) return requestedStoreId || null
  if (!user.storeId) throw Object.assign(new Error('当前账号没有绑定门店'), { statusCode: 403 })
  if (requestedStoreId && requestedStoreId !== user.storeId) {
    throw Object.assign(new Error('只能操作当前账号绑定的门店'), { statusCode: 403 })
  }
  return user.storeId
}

export const dishRoutes: FastifyPluginAsync = async (app) => {

  // ── 菜品列表 ──────────────────────────────────────
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { status, category, withCost } = req.query as any
    const where: any = { tenantId }
    if (category && category !== 'all') where.category = category
    const dishes = await prisma.dish.findMany({
      where, orderBy: [{ status: 'asc' }, { category: 'asc' }, { name: 'asc' }],
      include: {
        bomVersions: withCost === '1' ? {
          where: { status: 'PUBLISHED' },
          include: { items: { include: { product: { select: {
            name: true, unit: true, price: true, spec: true,
            inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
          } } } } },
        } : false,
      },
    })
    const visible = status
      ? dishes.filter((dish: any) => effectiveDishStatus(dish) === status)
      : dishes
    if (withCost === '1') {
      const enriched = visible.map((d: any) => {
        const businessDate = chinaDateText()
        const current = selectEffectiveBomVersion(d.bomVersions || [], businessDate, '')
        const activeBomVariants = [...new Set((d.bomVersions || [])
          .filter((version: any) => isBomVersionEffective(version, businessDate) && version.items?.length)
          .map((version: any) => version.variantKey))].sort() as string[]
        const recipes = (current?.items || []).map((item: any) => ({ ...item, variantKey: '' }))
        return {
          ...d,
          status: effectiveDishStatus(d),
          recipes,
          activeBomVersion: current || null,
          activeBomVariants,
          hasAnyEffectiveBom: activeBomVariants.length > 0,
          primaryBomVariant: activeBomVariants.includes('') ? '' : (activeBomVariants[0] || ''),
          // BOM 只描述用量。菜品成本必须来自入库移动平均成本快照，
          // 不能再拿采购包装价直接乘基础单位用量。
          foodCost: null,
          grossProfit: null,
          grossMargin: null,
          costStatus: 'FROM_MOVING_AVERAGE_SNAPSHOTS',
        }
      })
      return reply.send(enriched)
    }
    return reply.send(visible.map((dish: any) => ({ ...dish, status: effectiveDishStatus(dish) })))
  })

  // 最近真实销售的 BOM 覆盖率。总厨以销量/收入覆盖率为优先级，不以菜品条数自我安慰。
  app.get('/bom-coverage', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const parsed = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const end = dateOnly(chinaDateText())!
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - parsed.data.days + 1)
    const [sales, pending, dishes] = await Promise.all([
      prisma.dishSale.findMany({
        where: { tenantId, date: { gte: start, lte: end } },
        select: { quantity: true, grossAmount: true },
      }),
      prisma.deferredBomTask.findMany({
        where: { tenantId, status: 'PENDING', businessDate: { gte: start, lte: end } },
        select: {
          id: true, rawDishName: true, spec: true, variantKey: true, reasonCode: true,
          quantity: true, netIncome: true, saleRecorded: true, businessDate: true,
          dish: { select: { id: true, name: true } }, store: { select: { name: true } },
        },
      }),
      prisma.dish.findMany({
        where: { tenantId },
        select: {
          id: true, status: true, availableFrom: true, availableTo: true, inventoryPolicy: true,
          bomVersions: { where: { status: 'PUBLISHED' }, include: { items: true } },
        },
      }),
    ])
    const saleQuantity = sales.reduce((sum, row) => sum + Number(row.quantity), 0)
    const saleRevenue = sales.reduce((sum, row) => sum + Number(row.grossAmount), 0)
    const unmatchedQuantity = pending.filter(row => !row.saleRecorded).reduce((sum, row) => sum + Number(row.quantity), 0)
    const unmatchedRevenue = pending.filter(row => !row.saleRecorded).reduce((sum, row) => sum + Number(row.netIncome), 0)
    const uncoveredQuantity = pending.reduce((sum, row) => sum + Number(row.quantity), 0)
    const uncoveredRevenue = pending.reduce((sum, row) => sum + Number(row.netIncome), 0)
    const totalQuantity = saleQuantity + unmatchedQuantity
    const totalRevenue = saleRevenue + unmatchedRevenue
    const relevantDishes = dishes.filter(dish => ['ACTIVE', 'UPCOMING'].includes(effectiveDishStatus(dish)))
    const readyDishes = relevantDishes.filter(dish => dish.inventoryPolicy === 'EXCLUDE'
      || Boolean(selectEffectiveBomVersion(dish.bomVersions, chinaDateText(), '')?.items.length))
    const issueGroups = new Map<string, any>()
    for (const row of pending) {
      const key = `${row.rawDishName}\u0000${row.variantKey}`
      const current = issueGroups.get(key) || {
        rawDishName: row.rawDishName, spec: row.spec, variantKey: row.variantKey,
        reasonCode: row.reasonCode, dish: row.dish, quantity: 0, netIncome: 0,
        firstBusinessDate: dateText(row.businessDate), stores: new Set<string>(), taskCount: 0,
      }
      current.quantity += Number(row.quantity)
      current.netIncome += Number(row.netIncome)
      current.firstBusinessDate = [current.firstBusinessDate, dateText(row.businessDate)].sort()[0]
      current.stores.add(row.store.name)
      current.taskCount += 1
      issueGroups.set(key, current)
    }
    const ratio = (covered: number, total: number) => total > 0 ? Math.max(0, Math.min(1, covered / total)) : 1
    return {
      days: parsed.data.days,
      from: dateText(start),
      to: dateText(end),
      salesQuantityCoverage: ratio(totalQuantity - uncoveredQuantity, totalQuantity),
      salesRevenueCoverage: ratio(totalRevenue - uncoveredRevenue, totalRevenue),
      totalQuantity,
      uncoveredQuantity,
      totalRevenue,
      uncoveredRevenue,
      pendingTaskCount: pending.length,
      activeDishCount: relevantDishes.length,
      masterReadyCount: readyDishes.length,
      masterCoverage: ratio(readyDishes.length, relevantDishes.length),
      issues: [...issueGroups.values()]
        .map(row => ({ ...row, stores: [...row.stores] }))
        .sort((left, right) => right.netIncome - left.netIncome || right.quantity - left.quantity),
    }
  })

  // ── 菜品详情 ──────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const d = await prisma.dish.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        aliases: { where: { isActive: true }, orderBy: { rawName: 'asc' } },
        bomVersions: {
          orderBy: [{ variantKey: 'asc' }, { versionNo: 'desc' }],
          include: {
            items: {
              include: { product: { select: {
                id: true, name: true, unit: true, price: true, spec: true,
                inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
                supplier: { select: { name: true } },
              } } },
              orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
      },
    })
    if (!d) return reply.status(404).send({ error: '菜品不存在' })
    const current = selectEffectiveBomVersion(d.bomVersions as any, chinaDateText(), '') as any
    const recipes = (current?.items || []).map((item: any) => ({ ...item, variantKey: '' }))
    return reply.send({
      ...d, status: effectiveDishStatus(d), recipes, activeBomVersion: current || null,
      foodCost: null, grossProfit: null, grossMargin: null,
      costStatus: 'FROM_MOVING_AVERAGE_SNAPSHOTS',
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
    const { role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨可改配方' })
    return reply.status(409).send({
      error: '旧版配方直改入口已停用，请在菜品 BOM 版本中心建立草稿并发布',
      code: 'BOM_VERSION_WORKFLOW_REQUIRED',
    })
  })

  app.put('/recipes/:rid', auth(app), async (req: any, reply: any) => {
    const { role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    return reply.status(409).send({
      error: '已发布配方不可直接修改，请在菜品 BOM 版本中心建立变更草稿',
      code: 'BOM_VERSION_WORKFLOW_REQUIRED',
    })
  })

  app.delete('/recipes/:rid', auth(app), async (req: any, reply: any) => {
    const { role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    return reply.status(409).send({
      error: '已发布配方不可直接删除，请通过新 BOM 版本变更原材料',
      code: 'BOM_VERSION_WORKFLOW_REQUIRED',
    })
  })

  // ── 菜品别名：收银菜名长期映射 ───────────────────
  app.post('/:id/aliases', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可维护菜品别名' })
    const parsed = aliasSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const dish = await prisma.dish.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    const normalizedName = normalizeDishName(parsed.data.rawName)
    try {
      const alias = await prisma.dishAlias.create({
        data: { tenantId, dishId: dish.id, source: parsed.data.source, rawName: parsed.data.rawName, normalizedName, createdById: userId },
      })
      return reply.status(201).send(alias)
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(409).send({ error: '该收银菜名已经关联到菜品，请先检查现有映射' })
      throw error
    }
  })

  app.delete('/aliases/:aliasId', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const result = await prisma.dishAlias.updateMany({
      where: { id: req.params.aliasId, tenantId }, data: { isActive: false },
    })
    if (result.count === 0) return reply.status(404).send({ error: '菜品别名不存在' })
    return { ok: true }
  })

  // ── 版本化 BOM ─────────────────────────────────────
  app.get('/:id/bom-versions', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const dish = await prisma.dish.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    return prisma.dishBomVersion.findMany({
      where: { dishId: dish.id },
      orderBy: [{ variantKey: 'asc' }, { versionNo: 'desc' }],
      include: {
        items: {
          orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
          include: { product: { select: { id: true, code: true, name: true, spec: true, unit: true, price: true, status: true } } },
        },
      },
    })
  })

  app.post('/:id/bom-versions/draft', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可创建配方草稿' })
    const parsed = bomDraftSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const effectiveFrom = dateOnly(parsed.data.effectiveFrom)
    if (!effectiveFrom) return reply.status(400).send({ error: 'BOM 生效日期无效' })
    const variantKey = normalizeVariantKey(parsed.data.variantKey)
    try {
      const created = await prisma.$transaction(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`dish-bom:${tenantId}:${req.params.id}:${variantKey}`}))`)
        const dish = await tx.dish.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true } })
        if (!dish) throw Object.assign(new Error('菜品不存在'), { statusCode: 404 })
        const existingDraft = await tx.dishBomVersion.findFirst({
          where: { dishId: dish.id, variantKey, status: 'DRAFT' }, include: { items: true }, orderBy: { versionNo: 'desc' },
        })
        if (existingDraft) return existingDraft
        const latest = await tx.dishBomVersion.findFirst({
          where: { dishId: dish.id, variantKey }, orderBy: { versionNo: 'desc' },
        })
        const clone = parsed.data.cloneFromVersionId
          ? await tx.dishBomVersion.findFirst({
              where: { id: parsed.data.cloneFromVersionId, dishId: dish.id }, include: { items: true },
            })
          : await tx.dishBomVersion.findFirst({
              where: { dishId: dish.id, variantKey, status: 'PUBLISHED' }, include: { items: true }, orderBy: { versionNo: 'desc' },
            })
        return tx.dishBomVersion.create({
          data: {
            tenantId, dishId: dish.id, variantKey, versionNo: (latest?.versionNo || 0) + 1,
            changeType: parsed.data.changeType, changeReason: parsed.data.changeReason,
            effectiveFrom, createdById: userId,
            items: clone?.items?.length ? {
              create: clone.items.map(item => ({
                productId: item.productId, quantity: item.quantity, unit: item.unit,
                lossRate: item.lossRate, isMain: item.isMain, note: item.note,
              })),
            } : undefined,
          },
          include: { items: true },
        })
      })
      return reply.status(201).send(created)
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || '创建 BOM 草稿失败' })
    }
  })

  app.put('/bom-versions/:versionId/items', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可修改配方草稿' })
    const parsed = bomItemsSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const productIds = parsed.data.items.map(item => item.productId)
    if (new Set(productIds).size !== productIds.length) return reply.status(400).send({ error: '同一 BOM 版本中不能重复添加相同原材料' })
    const [version, products] = await Promise.all([
      prisma.dishBomVersion.findFirst({ where: { id: req.params.versionId, tenantId, status: 'DRAFT' }, select: { id: true } }),
      prisma.product.findMany({
        where: { tenantId, id: { in: productIds }, status: 'ENABLED' },
        select: {
          id: true, unit: true, inventoryUnit: true,
          inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
        },
      }),
    ])
    if (!version) return reply.status(404).send({ error: 'BOM 草稿不存在或已经发布' })
    const productMap = new Map(products.map(product => [product.id, product]))
    for (const item of parsed.data.items) {
      const product = productMap.get(item.productId)
      if (!product) return reply.status(400).send({ error: '配方包含不存在或已停用的原材料' })
      const contract = resolveProductInventoryUnit(product)
      if (!contract.structured || contract.status === 'PENDING') {
        return reply.status(409).send({ error: '原材料尚未完成采购单位与库存单位换算，请先在商品档案核验单位' })
      }
      if (contract.inventoryUnit !== item.unit) {
        return reply.status(400).send({ error: `配方单位必须使用库存基础单位（${contract.inventoryUnit}）` })
      }
    }
    await prisma.$transaction(async tx => {
      await tx.dishBomItem.deleteMany({ where: { versionId: version.id } })
      if (parsed.data.items.length > 0) {
        await tx.dishBomItem.createMany({ data: parsed.data.items.map(item => ({ versionId: version.id, ...item })) })
      }
    })
    return prisma.dishBomVersion.findUnique({
      where: { id: version.id }, include: { items: { include: { product: true } } },
    })
  })

  app.post('/bom-versions/:versionId/publish', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可发布配方' })
    const parsed = bomPublishSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const published = await prisma.$transaction(async tx => {
        const draft = await tx.dishBomVersion.findFirst({
          where: { id: req.params.versionId, tenantId, status: 'DRAFT' },
          include: { items: { include: { product: { select: {
            id: true, unit: true, status: true, inventoryUnit: true,
            inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
          } } } }, dish: true },
        })
        if (!draft) throw Object.assign(new Error('BOM 草稿不存在或已经发布'), { statusCode: 404 })
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`dish-bom:${tenantId}:${draft.dishId}:${draft.variantKey}`}))`)
        if (!draft.effectiveFrom) throw Object.assign(new Error('请先设置 BOM 生效日期'), { statusCode: 400 })
        if (draft.items.length === 0) throw Object.assign(new Error('BOM 至少需要一项有效原材料'), { statusCode: 400 })
        if (draft.items.some(item => {
          const contract = resolveProductInventoryUnit(item.product)
          return item.product.status !== 'ENABLED'
            || !contract.structured
            || contract.status === 'PENDING'
            || item.unit !== contract.inventoryUnit
        })) {
          throw Object.assign(new Error('BOM 包含已停用原材料或单位不一致，请修正后再发布'), { statusCode: 409 })
        }
        const today = chinaDateText()
        if (draft.changeType === 'HISTORICAL_CORRECTION' && dateText(draft.effectiveFrom) < today && !parsed.data.confirmHistoricalCorrection) {
          throw Object.assign(new Error('这是历史 BOM 纠错，发布后可能需要重新计算库存。请核对影响范围后再次确认'), {
            statusCode: 409, code: 'HISTORICAL_CONFIRMATION_REQUIRED',
          })
        }
        const existing = await tx.dishBomVersion.findMany({
          where: { dishId: draft.dishId, variantKey: draft.variantKey, status: 'PUBLISHED' }, orderBy: { effectiveFrom: 'asc' },
        })
        const overlaps = existing.filter(version => version.effectiveFrom && bomDateRangesOverlap(
          { effectiveFrom: draft.effectiveFrom!, effectiveTo: draft.effectiveTo },
          { effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo },
        ))
        const preceding = overlaps.filter(version => version.effectiveFrom! < draft.effectiveFrom!)
        const sameStart = overlaps.filter(version => version.effectiveFrom!.getTime() === draft.effectiveFrom!.getTime())
        const following = existing
          .filter(version => version.effectiveFrom! > draft.effectiveFrom!)
          .sort((left, right) => left.effectiveFrom!.getTime() - right.effectiveFrom!.getTime())
        if (draft.changeType !== 'HISTORICAL_CORRECTION' && (sameStart.length > 0 || following.length > 0)) {
          throw Object.assign(new Error('该生效日期之后已有发布版本，请调整日期或先处理未来版本'), { statusCode: 409 })
        }
        if (preceding.length > 0) {
          await tx.dishBomVersion.updateMany({
            where: { id: { in: preceding.map(version => version.id) } },
            data: { effectiveTo: utcDayBefore(draft.effectiveFrom) },
          })
        }
        if (draft.changeType === 'HISTORICAL_CORRECTION' && sameStart.length > 0) {
          await tx.dishBomVersion.updateMany({
            where: { id: { in: sameStart.map(version => version.id) } },
            data: { status: 'RETIRED' },
          })
        }
        const correctedEffectiveTo = draft.changeType === 'HISTORICAL_CORRECTION' && following[0]?.effectiveFrom
          ? utcDayBefore(following[0].effectiveFrom)
          : draft.effectiveTo
        const result = await tx.dishBomVersion.update({
          where: { id: draft.id },
          data: {
            status: 'PUBLISHED', publishedById: userId, publishedAt: new Date(),
            effectiveTo: correctedEffectiveTo,
          },
          include: { items: { include: { product: true } } },
        })
        if (dateText(draft.effectiveFrom) <= today) {
          await tx.dishRecipe.deleteMany({ where: { dishId: draft.dishId, variantKey: draft.variantKey } })
          await tx.dishRecipe.createMany({
            data: draft.items.map(item => ({
              dishId: draft.dishId, variantKey: draft.variantKey, productId: item.productId,
              quantity: item.quantity, unit: item.unit, lossRate: item.lossRate, isMain: item.isMain, note: item.note,
            })),
          })
        }
        await tx.opLog.create({
          data: {
            tenantId, userId, role, action: `发布菜品 BOM v${draft.versionNo}`,
            target: draft.dish.name, targetId: draft.id, entityType: 'DishBomVersion',
            metadata: { variantKey: draft.variantKey, effectiveFrom: dateText(draft.effectiveFrom), changeType: draft.changeType, reason: draft.changeReason },
          },
        })
        return result
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
      return reply.send(published)
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || '发布 BOM 失败', code: error.code })
    }
  })

  // ── 上新、下架与重新上架 ──────────────────────────
  app.post('/:id/lifecycle', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!CHEF_ROLES.includes(role)) return reply.status(403).send({ error: '仅总厨/管理员可调整菜品状态' })
    const parsed = lifecycleSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const effectiveDate = dateOnly(parsed.data.effectiveDate)
    if (!effectiveDate) return reply.status(400).send({ error: '生效日期无效' })
    const dish = await prisma.dish.findFirst({
      where: { id: req.params.id, tenantId },
      include: { bomVersions: { where: { status: 'PUBLISHED' }, include: { items: true } } },
    })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    if (parsed.data.action !== 'DELIST' && dish.inventoryPolicy === 'BOM') {
      const version = selectEffectiveBomVersion(dish.bomVersions, effectiveDate, '')
      if (!version?.items.length) return reply.status(409).send({ error: '在售菜品必须先发布该生效日可用的默认 BOM' })
    }
    if (!parsed.data.groupWide && parsed.data.storeIds.length === 0) return reply.status(400).send({ error: '请选择至少一家适用门店' })
    const today = chinaDateText()
    const nextStatus = parsed.data.action === 'DELIST'
      ? (parsed.data.effectiveDate <= today ? 'DISABLED' : dish.status)
      : (parsed.data.effectiveDate <= today ? 'ACTIVE' : 'UPCOMING')
    const updated = await prisma.$transaction(async tx => {
      const row = await tx.dish.update({
        where: { id: dish.id },
        data: {
          status: nextStatus as any,
          groupWide: parsed.data.groupWide,
          storeIds: parsed.data.groupWide ? [] : parsed.data.storeIds,
          availableFrom: parsed.data.action === 'DELIST' ? dish.availableFrom : effectiveDate,
          availableTo: parsed.data.action === 'DELIST' ? effectiveDate : null,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role, action: `菜品${parsed.data.action === 'DELIST' ? '下架' : parsed.data.action === 'RELIST' ? '重新上架' : '上新发布'}`,
          target: dish.name, targetId: dish.id, entityType: 'Dish',
          metadata: { effectiveDate: parsed.data.effectiveDate, reason: parsed.data.reason, groupWide: parsed.data.groupWide, storeIds: parsed.data.storeIds },
        },
      })
      return row
    })
    return updated
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
      prisma.dish.findFirst({
        where: { id: d.dishId, tenantId },
        include: { bomVersions: { where: { status: 'PUBLISHED' }, include: { items: { include: { product: true } } } } },
      }),
    ])
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    if (!dish) return reply.status(404).send({ error: '菜品不存在' })
    const bomVersion = dish.inventoryPolicy === 'BOM'
      ? selectEffectiveBomVersion(dish.bomVersions, saleDate, '')
      : null
    if (dish.inventoryPolicy === 'BOM' && !bomVersion?.items.length) {
      return reply.status(409).send({ error: '该营业日期缺少可执行 BOM，请总厨补齐后再录入销量' })
    }

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
      const consumptions = calculateBomConsumptions(Number(d.quantity), bomVersion!.items).map(item => {
        const bomItem = bomVersion!.items.find(candidate => candidate.productId === item.productId)!
        const normalized = convertQuantityToInventoryUnit({
          quantity: item.quantity, sourceUnit: bomItem.unit, product: bomItem.product, productSpec: bomItem.product.spec,
        })
        if (normalized.normalizedQuantity == null) {
          throw Object.assign(new Error(`原材料“${bomItem.product.name}”单位换算待核验`), { statusCode: 409 })
        }
        return {
        tenantId, storeId: d.storeId, productId: item.productId, date: saleDate,
        quantity: new Prisma.Decimal(item.quantity.toFixed(6)), unitSnapshot: bomItem.unit,
        inventoryQuantity: new Prisma.Decimal(normalized.normalizedQuantity.toFixed(6)),
        inventoryUnitSnapshot: normalized.normalizedUnit,
        note: `菜品销售 ${d.quantity} 份`,
        sourceType: 'dish_sale', sourceId: saved.id, sourceLineKey: bomVersion!.id,
        dishId: dish.id, variantKey: '', bomVersionId: bomVersion!.id,
        calculationSnapshot: bomCalculationSnapshot({
          dishId: dish.id, dishName: dish.name, variantKey: '', saleQuantity: Number(d.quantity), version: bomVersion!,
        }) as any,
        createdById: userId,
        }
      })
      if (consumptions.length > 0) await tx.stockConsumption.createMany({ data: consumptions })
      return saved
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 })
    await revalueStoreConsumptionCosts(tenantId, d.storeId).catch(error => {
      req.log.error({ error, storeId: d.storeId }, 'manual dish sale cost snapshot refresh failed')
    })
    return sale
  })

  // ── 销量榜 (单月/单店或集团) ───────────────────────
  app.get('/sales-rank', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!VIEW_ROLES.includes(role)) return reply.status(403).send({ error: '无权' })
    const { month, storeId, limit = '20' } = req.query as any
    const parsedLimit = parseBoundedInteger(limit, { defaultValue: 20, max: 100 })
    if (parsedLimit === null) return reply.status(400).send({ error: '榜单条数格式不正确' })
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
      take: parsedLimit,
    })
    if (rows.length === 0) return []
    const dishIds = rows.map(r => r.dishId)
    const [dishes, consumptionRows] = await Promise.all([
      prisma.dish.findMany({ where: { id: { in: dishIds } } }),
      prisma.stockConsumption.findMany({
        where: {
          tenantId, dishId: { in: dishIds }, date: { gte: start, lte: end },
          ...(where.storeId ? { storeId: where.storeId } : {}),
          sourceType: { in: ['daily_pos', 'daily_bom_backfill', 'dish_sale', 'correction'] },
          voidedAt: null,
        },
        select: { dishId: true, costAmountSnapshot: true },
      }),
    ])
    const dishMap = new Map(dishes.map(d => [d.id, d]))
    const actualCost = new Map<string, number>()
    for (const consumption of consumptionRows) {
      if (!consumption.dishId) continue
      if (consumption.costAmountSnapshot != null) {
        actualCost.set(consumption.dishId, (actualCost.get(consumption.dishId) || 0)
          + Number(consumption.costAmountSnapshot))
      }
    }
    return rows.map(r => {
      const d = dishMap.get(r.dishId) as any
      if (!d) return null
      const qty = Number(r._sum.quantity || 0)
      const gross = Number(r._sum.grossAmount || 0)
      const hasCost = actualCost.has(d.id)
      const totalCost = hasCost ? actualCost.get(d.id)! : null
      const unitCost = totalCost != null && qty > 0 ? totalCost / qty : null
      return {
        dishId: d.id, name: d.name, category: d.category,
        salePrice: Number(d.salePrice),
        unitCost: unitCost == null ? null : Math.round(unitCost * 100) / 100,
        qty, gross,
        totalCost: totalCost == null ? null : Math.round(totalCost * 100) / 100,
        grossProfit: totalCost == null ? null : Math.round((gross - totalCost) * 100) / 100,
        grossMargin: totalCost != null && gross > 0 ? (gross - totalCost) / gross : null,
        costStatus: hasCost ? 'MOVING_AVERAGE' : 'PENDING_COST_SNAPSHOT',
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

    const consumptions = await prisma.stockConsumption.findMany({
      where: {
        tenantId,
        ...(where.date ? { date: where.date } : {}),
        ...(where.storeId ? { storeId: where.storeId } : {}),
        sourceType: { in: ['daily_pos', 'daily_bom_backfill', 'dish_sale', 'correction'] },
        voidedAt: null,
      },
      include: { product: { select: { id: true, name: true, unit: true, inventoryUnit: true, spec: true } } },
    })
    if (consumptions.length === 0) return []

    // 直接汇总已落账消耗；每条记录已经冻结了营业日对应的 BOM 版本。
    const consumed = new Map<string, { name: string; unit: string; qty: number }>()
    for (const r of consumptions) {
      const cur = consumed.get(r.productId) || {
        name: r.product?.name || '?',
        unit: r.inventoryUnitSnapshot || r.product?.inventoryUnit || r.product?.unit || '',
        qty: 0,
      }
      cur.qty += Number(r.inventoryQuantity ?? r.quantity)
      consumed.set(r.productId, cur)
    }

    return Array.from(consumed.entries()).map(([productId, v]) => ({
      productId, ...v,
      qty: Math.round(v.qty * 1000) / 1000,
    })).sort((a, b) => b.qty - a.qty)
  })
}
