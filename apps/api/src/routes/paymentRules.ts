import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const CONDITION_LABELS: Record<string, string> = {
  AMOUNT_OVER:   '单笔金额超过',
  MONTHLY_OVER:  '月累计超过',
  NEW_SUPPLIER:  '新供应商首次付款',
  ALWAYS_AUTO:   '始终自动付款',
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
  app.post('/', auth(app), async (req: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const { name, description, condition, threshold, action, priority } = req.body as any

    if (!name || !condition || !action) throw { statusCode: 400, message: '请填写完整规则信息' }

    const rule = await prisma.paymentRule.create({
      data: { tenantId, name, description, condition, threshold, action, priority: priority || 0 },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, action: `创建付款规则：${name}`, entityType: 'PaymentRule', targetId: rule.id },
    })
    return rule
  })

  // 更新规则
  app.patch('/:id', auth(app), async (req: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const { name, description, condition, threshold, action, priority, enabled } = req.body as any

    const rule = await prisma.paymentRule.findFirst({ where: { id: req.params.id, tenantId } })
    if (!rule) throw { statusCode: 404, message: '规则不存在' }

    const updated = await prisma.paymentRule.update({
      where: { id: rule.id },
      data: { name, description, condition, threshold, action, priority, enabled },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, action: `更新付款规则：${updated.name}`, entityType: 'PaymentRule', targetId: rule.id },
    })
    return updated
  })

  // 删除规则
  app.delete('/:id', auth(app), async (req: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }

    const rule = await prisma.paymentRule.findFirst({ where: { id: req.params.id, tenantId } })
    if (!rule) throw { statusCode: 404, message: '规则不存在' }

    await prisma.paymentRule.delete({ where: { id: rule.id } })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `删除付款规则：${rule.name}`, entityType: 'PaymentRule', targetId: rule.id },
    })
    return { success: true }
  })

  // 规则引擎：判断某笔付款应该怎么处理
  app.post('/evaluate', auth(app), async (req: any) => {
    const { tenantId } = req.user
    const { supplierId, amount } = req.body as any

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

    // 默认自动付款
    return { action: 'auto_pay', ruleName: '默认规则', needApproval: false }
  })
}
