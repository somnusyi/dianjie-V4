/**
 * 配送班表（门店订货→到货节奏）。
 * - 供应链治理角色（SUPPLY_CHAIN/ADMIN/SUPER_ADMIN）自助维护：列表/新建/编辑/启停
 * - 门店下单侧用 /for-store 查询本店适用班表：默认到货日、送货日预览、订货时段
 * - enforce=true 的班表在下单接口里硬拦截（见 orders.ts）
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import {
  earliestArrivalDate,
  isEffectiveOn,
  isWithinOrderWindow,
  nextDeliveryDates,
} from '../services/deliveryRuleDates'
import { businessDateKey } from '../lib/businessTime'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const GOVERNANCE_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式为 HH:MM')
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式为 YYYY-MM-DD')

const ruleBaseSchema = z.object({
  name: z.string().trim().min(1, '班表名称不能为空').max(80),
  supplierId: z.union([z.string().trim().min(1), z.null()]).optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, '至少选择一个送货日').max(7),
  leadDays: z.number().int().min(1, '到货期至少为第 1 个送货日').max(7),
  orderWindowStart: z.union([timeSchema, z.null()]).optional(),
  orderWindowEnd: z.union([timeSchema, z.null()]).optional(),
  enforce: z.boolean().default(false),
  effectiveFrom: z.union([dateSchema, z.null()]).optional(),
  effectiveTo: z.union([dateSchema, z.null()]).optional(),
  note: z.union([z.string().trim().max(240), z.null()]).optional(),
  storeIds: z.array(z.string().trim().min(1)).min(1, '至少选择一家适用门店').max(200),
}).strict()

function ruleCrossChecks(value: { orderWindowStart?: string | null; orderWindowEnd?: string | null; effectiveFrom?: string | null; effectiveTo?: string | null }, ctx: z.RefinementCtx) {
  if ((value.orderWindowStart && !value.orderWindowEnd) || (!value.orderWindowStart && value.orderWindowEnd)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['orderWindowStart'], message: '订货时段起止要同时填写或同时留空' })
  }
  if (value.effectiveFrom && value.effectiveTo && value.effectiveFrom > value.effectiveTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveTo'], message: '失效日期不能早于生效日期' })
  }
}

const ruleBodySchema = ruleBaseSchema.superRefine(ruleCrossChecks)

const rulePatchSchema = ruleBaseSchema.partial().extend({
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
}).strict().superRefine(ruleCrossChecks).refine(value => Object.keys(value).length > 0, '没有可更新字段')

function firstIssue(parsed: { success: false; error: z.ZodError }) {
  return parsed.error.issues[0]?.message || '请求参数错误'
}

async function generateRuleNo(tenantId: string) {
  const day = businessDateKey().replace(/-/g, '')
  const count = await prisma.deliveryRule.count({ where: { tenantId, no: { startsWith: `PS${day}-` } } })
  return `PS${day}-${String(count + 1).padStart(3, '0')}`
}

const storeInclude = { stores: { include: { store: { select: { id: true, no: true, name: true } } } } } as const

export const deliveryRuleRoutes: FastifyPluginAsync = async (app) => {

  // 班表列表（供应链治理角色）
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    if (!GOVERNANCE_ROLES.has(role)) throw { statusCode: 403, message: '只有供应链治理角色可以查看配送班表' }
    return prisma.deliveryRule.findMany({
      where: { tenantId },
      include: { ...storeInclude, supplier: { select: { id: true, name: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })
  })

  // 门店侧查询：本店 + 指定供应商的适用班表（下单页默认到货日 / 提示用）
  app.get('/for-store', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId: myStoreId } = req.user
    const parsed = z.object({
      storeId: z.string().trim().min(1).optional(),
      supplierId: z.union([z.string().trim().min(1), z.null()]).optional(),
    }).safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const storeId = GOVERNANCE_ROLES.has(role) ? parsed.data.storeId : myStoreId
    if (!storeId) return { rule: null }
    const today = businessDateKey()
    const rules = await prisma.deliveryRule.findMany({
      where: {
        tenantId, status: 'ENABLED',
        stores: { some: { storeId } },
        ...(parsed.data.supplierId
          ? { OR: [{ supplierId: parsed.data.supplierId }, { supplierId: null }] }
          : {}),
      },
      include: { supplier: { select: { id: true, name: true } } },
      orderBy: [{ enforce: 'desc' }, { createdAt: 'asc' }],
    })
    const active = rules.filter(rule => isEffectiveOn(rule, today))
    // 门店专属班表优先于通用班表（supplierId 精确匹配优先）
    const rule = (parsed.data.supplierId && active.find(r => r.supplierId === parsed.data.supplierId)) || active[0] || null
    if (!rule) return { rule: null }
    return {
      rule: {
        id: rule.id, no: rule.no, name: rule.name, weekdays: rule.weekdays,
        leadDays: rule.leadDays, orderWindowStart: rule.orderWindowStart, orderWindowEnd: rule.orderWindowEnd,
        enforce: rule.enforce, supplier: rule.supplier,
        nextDeliveryDates: nextDeliveryDates(rule, today, 6),
        earliestArrival: earliestArrivalDate(rule, today),
        withinOrderWindow: isWithinOrderWindow(rule),
      },
    }
  })

  // 新建班表
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!GOVERNANCE_ROLES.has(role)) throw { statusCode: 403, message: '只有供应链治理角色可以维护配送班表' }
    const parsed = ruleBodySchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const data = parsed.data
    if (data.supplierId) {
      const supplier = await prisma.supplier.findFirst({ where: { id: data.supplierId, tenantId }, select: { id: true } })
      if (!supplier) return reply.status(400).send({ error: '供货机构不存在或不属于当前租户' })
    }
    const stores = await prisma.store.findMany({ where: { id: { in: data.storeIds }, tenantId }, select: { id: true } })
    if (stores.length !== new Set(data.storeIds).size) return reply.status(400).send({ error: '存在无效门店，请刷新后重试' })

    const created = await prisma.$transaction(async (tx) => {
      const rule = await tx.deliveryRule.create({
        data: {
          tenantId, no: await generateRuleNo(tenantId), name: data.name,
          supplierId: data.supplierId ?? null,
          weekdays: Array.from(new Set(data.weekdays)).sort((a, b) => a - b),
          leadDays: data.leadDays,
          orderWindowStart: data.orderWindowStart ?? null,
          orderWindowEnd: data.orderWindowEnd ?? null,
          enforce: data.enforce,
          effectiveFrom: data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00+08:00`) : null,
          effectiveTo: data.effectiveTo ? new Date(`${data.effectiveTo}T00:00:00+08:00`) : null,
          note: data.note ?? null,
          stores: { create: data.storeIds.map(storeId => ({ storeId })) },
        },
        include: storeInclude,
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `新建配送班表 ${rule.name}（${rule.no}）：周${rule.weekdays.join('/')}送货，${rule.stores.length} 家门店`,
          entityType: 'DeliveryRule', target: rule.no, targetId: rule.id,
        },
      })
      return rule
    })
    return created
  })

  // 编辑 / 启停班表
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!GOVERNANCE_ROLES.has(role)) throw { statusCode: 403, message: '只有供应链治理角色可以维护配送班表' }
    const { id } = req.params as any
    const parsed = rulePatchSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const data = parsed.data
    const before = await prisma.deliveryRule.findFirst({ where: { id, tenantId }, include: storeInclude })
    if (!before) return reply.status(404).send({ error: '班表不存在或无权修改' })

    const updated = await prisma.$transaction(async (tx) => {
      if (data.storeIds) {
        const stores = await tx.store.findMany({ where: { id: { in: data.storeIds }, tenantId }, select: { id: true } })
        if (stores.length !== new Set(data.storeIds).size) throw { statusCode: 400, message: '存在无效门店，请刷新后重试' }
        await tx.deliveryRuleStore.deleteMany({ where: { ruleId: id } })
        await tx.deliveryRuleStore.createMany({ data: data.storeIds.map(storeId => ({ ruleId: id, storeId })) })
      }
      const rule = await tx.deliveryRule.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
          ...(data.weekdays ? { weekdays: Array.from(new Set(data.weekdays)).sort((a, b) => a - b) } : {}),
          ...(data.leadDays !== undefined ? { leadDays: data.leadDays } : {}),
          ...(data.orderWindowStart !== undefined ? { orderWindowStart: data.orderWindowStart } : {}),
          ...(data.orderWindowEnd !== undefined ? { orderWindowEnd: data.orderWindowEnd } : {}),
          ...(data.enforce !== undefined ? { enforce: data.enforce } : {}),
          ...(data.effectiveFrom !== undefined ? { effectiveFrom: data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00+08:00`) : null } : {}),
          ...(data.effectiveTo !== undefined ? { effectiveTo: data.effectiveTo ? new Date(`${data.effectiveTo}T00:00:00+08:00`) : null } : {}),
          ...(data.note !== undefined ? { note: data.note } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
        include: storeInclude,
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `更新配送班表 ${rule.name}（${rule.no}）${data.status === 'DISABLED' ? '：停用' : data.status === 'ENABLED' ? '：启用' : ''}`,
          entityType: 'DeliveryRule', target: rule.no, targetId: rule.id,
          metadata: { before: { status: before.status }, patch: data },
        },
      })
      return rule
    })
    return updated
  })
}
