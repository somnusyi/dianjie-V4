import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const conditionSchema = z.enum(['AMOUNT_OVER', 'MONTHLY_OVER', 'NEW_SUPPLIER', 'ALWAYS_AUTO'])
const actionSchema = z.enum(['auto_pay', 'require_approval', 'block'])
const entityIdSchema = z.string().trim().min(1).max(64)
const moneySchema = z.number().finite().min(0).max(1_000_000_000)
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.union([z.string().trim().max(500), z.null()]).optional(),
  condition: conditionSchema,
  threshold: z.union([moneySchema, z.null()]).optional(),
  action: actionSchema,
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().optional().default(true),
}).strict().superRefine((value, ctx) => {
  const needsThreshold = value.condition === 'AMOUNT_OVER' || value.condition === 'MONTHLY_OVER'
  if (needsThreshold && value.threshold == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['threshold'], message: '该条件必须填写金额阈值' })
  }
  if (!needsThreshold && value.threshold != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['threshold'], message: '该条件不使用金额阈值' })
  }
})
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.union([z.string().trim().max(500), z.null()]).optional(),
  condition: conditionSchema.optional(),
  threshold: z.union([moneySchema, z.null()]).optional(),
  action: actionSchema.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, '没有可更新字段')
const evaluateSchema = z.object({
  supplierId: entityIdSchema,
  amount: moneySchema.refine(value => value > 0, '付款金额必须大于 0'),
}).strict()

function firstIssue(parsed: { success: false; error: z.ZodError }) {
  return parsed.error.issues[0]?.message || '请求参数错误'
}

export const paymentRuleRoutes: FastifyPluginAsync = async (app) => {

  // 获取规则列表
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    return prisma.paymentRule.findMany({
      where: { tenantId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    })
  })

  // 创建规则
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const parsed = ruleSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })

    return prisma.$transaction(async tx => {
      const rule = await tx.paymentRule.create({ data: { tenantId, ...parsed.data } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `创建付款规则：${rule.name}`,
          entityType: 'PaymentRule', targetId: rule.id,
          metadata: { condition: rule.condition, action: rule.action, priority: rule.priority },
        },
      })
      return rule
    })
  })

  // 更新规则
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: firstIssue(idParsed) })
    const patch = updateSchema.safeParse(req.body || {})
    if (!patch.success) return reply.status(400).send({ error: firstIssue(patch) })

    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-rule:${idParsed.data}`}))::text AS locked`
      const rule = await tx.paymentRule.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!rule) throw { statusCode: 404, message: '规则不存在' }
      const candidate = ruleSchema.safeParse({
        name: patch.data.name ?? rule.name,
        description: patch.data.description === undefined ? rule.description : patch.data.description,
        condition: patch.data.condition ?? rule.condition,
        threshold: patch.data.threshold === undefined ? (rule.threshold == null ? null : Number(rule.threshold)) : patch.data.threshold,
        action: patch.data.action ?? rule.action,
        priority: patch.data.priority ?? rule.priority,
        enabled: patch.data.enabled ?? rule.enabled,
      })
      if (!candidate.success) throw { statusCode: 400, message: firstIssue(candidate) }
      const updated = await tx.paymentRule.update({ where: { id: rule.id }, data: candidate.data })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `更新付款规则：${updated.name}`,
          entityType: 'PaymentRule', targetId: rule.id,
          metadata: { changedFields: Object.keys(patch.data), condition: updated.condition, action: updated.action },
        },
      })
      return updated
    })
  })

  // 删除规则
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: firstIssue(idParsed) })

    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-rule:${idParsed.data}`}))::text AS locked`
      const rule = await tx.paymentRule.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!rule) throw { statusCode: 404, message: '规则不存在' }
      await tx.paymentRule.delete({ where: { id: rule.id } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `删除付款规则：${rule.name}`,
          entityType: 'PaymentRule', targetId: rule.id,
          metadata: { condition: rule.condition, action: rule.action },
        },
      })
    })
    return { success: true }
  })

  // 规则引擎：判断某笔付款应该怎么处理
  app.post('/evaluate', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const parsed = evaluateSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const { supplierId, amount } = parsed.data
    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, tenantId, status: 'ENABLED' }, select: { id: true } })
    if (!supplier) return reply.status(400).send({ error: '供应商不存在或已停用' })

    const rules = await prisma.paymentRule.findMany({
      where: { tenantId, enabled: true },
      orderBy: { priority: 'desc' },
    })

    // 检查是否是新供应商
    const supplierOrderCount = await prisma.paymentSchedule.count({
      where: { tenantId, supplierId, status: 'PAID' },
    })
    const isNewSupplier = supplierOrderCount === 0

    // 本月累计付款
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const monthlyTotal = await prisma.paymentSchedule.aggregate({
      where: { tenantId, supplierId, status: { in: ['PENDING', 'APPROVED', 'PAID'] }, confirmedAt: { gte: monthStart } },
      _sum: { amount: true },
    })
    const monthlyAmount = Number(monthlyTotal._sum.amount || 0) + Number(amount)

    // 逐条匹配规则
    for (const rule of rules) {
      let matched = false
      switch (rule.condition) {
        case 'ALWAYS_AUTO':
          matched = true; break
        case 'NEW_SUPPLIER':
          matched = isNewSupplier; break
        case 'AMOUNT_OVER':
          matched = Number(amount) > Number(rule.threshold || 0); break
        case 'MONTHLY_OVER':
          matched = monthlyAmount > Number(rule.threshold || 0); break
      }
      if (matched) {
        return {
          action: rule.action,
          ruleName: rule.name,
          ruleId: rule.id,
          needApproval: rule.action === 'require_approval',
        }
      }
    }

    // 没有规则明确放行时必须人工审批，防止空配置或错误优先级直接触发真实付款。
    return { action: 'require_approval', ruleName: '安全默认规则', needApproval: true }
  })
}
