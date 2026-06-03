/**
 * 工资模块 (P2-1) — 简化版
 *
 * 流程: 财务上传 Excel 工资单 → 系统建 Payroll batch + 多 PayrollItem
 *       → 财务/老板审批 → 发放 (mark-paid) → 自动生成凭证
 *
 * 凭证 (简化版本: 不分项, 单笔):
 *   借 5602 管理费用-工资  (totalGross)
 *   贷 1002 银行存款 / 1001 现金  (totalNet)
 *   贷 2211 应付职工薪酬-社保  (totalSocialSec, 可空)
 *   贷 2221 应交税费-个税  (totalTax, 可空)
 *   - 借贷自动平账, 后续可用凭证编辑改细
 *
 * Endpoints:
 *   GET    /api/payroll                 列表
 *   GET    /api/payroll/:id             详情 (含 items)
 *   POST   /api/payroll                 新建 (body: { storeId, month, items[] })
 *   PATCH  /api/payroll/:id/approve     审批
 *   PATCH  /api/payroll/:id/mark-paid   发放 + 自动建凭证 (body: { payMethod, bankTxNo? })
 *   PATCH  /api/payroll/:id/void        作废
 *   DELETE /api/payroll/:id             删除 (仅 DRAFT)
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { createVoucher } from '../services/voucher'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])

// 工资 → 会计科目映射 (5xxx 体系)
const ACCT = {
  expenseGross: { code: '5602', name: '管理费用-工资' },
  cashOut:      { code: '1002', name: '银行存款' },
  socialSec:    { code: '2211', name: '应付职工薪酬-社保' },
  tax:          { code: '2221', name: '应交税费-个人所得税' },
}

const itemSchema = z.object({
  employeeName: z.string().min(1),
  position: z.string().optional(),
  baseSalary: z.number().nonnegative().optional(),
  bonus: z.number().nonnegative().optional(),
  overtime: z.number().nonnegative().optional(),
  deductSocialSec: z.number().nonnegative().optional(),
  deductTax: z.number().nonnegative().optional(),
  deductOther: z.number().nonnegative().optional(),
  netAmount: z.number().nonnegative(),
  note: z.string().optional(),
})

const createSchema = z.object({
  storeId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  items: z.array(itemSchema).min(1, '至少 1 个员工'),
  note: z.string().optional(),
})

export const payrollRoutes: FastifyPluginAsync = async (app) => {

  // 列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可查' })
    const { month, status, storeId } = (req.query as any) || {}
    const where: any = { tenantId }
    if (month) where.month = month
    if (status) where.status = status
    if (storeId) where.storeId = storeId
    return prisma.payroll.findMany({
      where,
      include: {
        store: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
    })
  })

  // 详情
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可查' })
    const p = await prisma.payroll.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true } },
        items: { orderBy: { employeeName: 'asc' } },
      },
    })
    if (!p) return reply.status(404).send({ error: '工资单不存在' })
    return p
  })

  // 新建
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可新建' })
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const store = await prisma.store.findFirst({ where: { id: parsed.data.storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    // 汇总
    const items = parsed.data.items
    const totalGross = items.reduce((s, i) =>
      s + (i.baseSalary || 0) + (i.bonus || 0) + (i.overtime || 0), 0)
    const totalNet = items.reduce((s, i) => s + i.netAmount, 0)
    const totalSocialSec = items.reduce((s, i) => s + (i.deductSocialSec || 0), 0)
    const totalTax = items.reduce((s, i) => s + (i.deductTax || 0), 0)

    try {
      const payroll = await prisma.payroll.create({
        data: {
          tenantId, storeId: parsed.data.storeId, month: parsed.data.month,
          totalGross: totalGross || null,
          totalNet,
          totalSocialSec: totalSocialSec || null,
          totalTax: totalTax || null,
          note: parsed.data.note || null,
          createdById: userId,
          items: { create: items.map(i => ({
            employeeName: i.employeeName,
            position: i.position || null,
            baseSalary: i.baseSalary || null,
            bonus: i.bonus || null,
            overtime: i.overtime || null,
            deductSocialSec: i.deductSocialSec || null,
            deductTax: i.deductTax || null,
            deductOther: i.deductOther || null,
            netAmount: i.netAmount,
            note: i.note || null,
          })) },
        },
        include: { items: true },
      })
      return reply.status(201).send(payroll)
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.status(409).send({ error: '本月该店已有工资单' })
      throw e
    }
  })

  // 审批
  app.patch('/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可审' })
    const p = await prisma.payroll.findFirst({ where: { id: req.params.id, tenantId } })
    if (!p) return reply.status(404).send({ error: '工资单不存在' })
    if (p.status !== 'DRAFT') return reply.status(400).send({ error: `当前状态 ${p.status} 不可审批` })
    const updated = await prisma.payroll.update({
      where: { id: p.id },
      data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
    })
    return updated
  })

  // 发放 + 自动建凭证
  const markPaidSchema = z.object({
    payMethod: z.string().min(1),
    bankTxNo: z.string().optional(),
    payDate: z.string().optional(),  // YYYY-MM-DD
  })
  app.patch('/:id/mark-paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可发放' })
    const parsed = markPaidSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })

    const p = await prisma.payroll.findFirst({
      where: { id: req.params.id, tenantId },
      include: { store: { select: { name: true } } },
    })
    if (!p) return reply.status(404).send({ error: '工资单不存在' })
    if (p.status !== 'APPROVED') return reply.status(400).send({ error: '仅 APPROVED 可发放' })

    const payDate = parsed.data.payDate ? new Date(parsed.data.payDate) : new Date()

    // 凭证分录: 借 5602 / 贷 1002 + 应付社保 + 应交税费
    const totalGross = Number(p.totalGross || p.totalNet)
    const totalNet = Number(p.totalNet)
    const totalSocialSec = Number(p.totalSocialSec || 0)
    const totalTax = Number(p.totalTax || 0)

    const entries: any[] = []
    entries.push({
      accountCode: ACCT.expenseGross.code,
      accountName: ACCT.expenseGross.name,
      debit: totalGross,
      credit: 0,
      summary: `${p.month} 工资 (${p.store.name})`,
    })
    // 银行/现金 (实发净额)
    entries.push({
      accountCode: parsed.data.payMethod === '现金' ? '1001' : ACCT.cashOut.code,
      accountName: parsed.data.payMethod === '现金' ? '库存现金' : ACCT.cashOut.name,
      debit: 0,
      credit: totalNet,
      summary: `${p.month} 工资发放`,
    })
    if (totalSocialSec > 0) {
      entries.push({
        accountCode: ACCT.socialSec.code, accountName: ACCT.socialSec.name,
        debit: 0, credit: totalSocialSec,
        summary: `${p.month} 工资 代扣社保`,
      })
    }
    if (totalTax > 0) {
      entries.push({
        accountCode: ACCT.tax.code, accountName: ACCT.tax.name,
        debit: 0, credit: totalTax,
        summary: `${p.month} 工资 代扣个税`,
      })
    }

    let voucherId: string | null = null
    try {
      voucherId = await createVoucher({
        tenantId,
        date: payDate,
        summary: `${p.month} 工资发放 (${p.store.name})`,
        word: '记',
        sourceType: 'Payroll',
        sourceId: p.id,
        entries,
        createdById: userId,
        lockMode: 'auto',
        autoPost: true,   // BUG#8: 工资已发放, 直接 POSTED
      })
    } catch (e: any) {
      console.error('[payroll] voucher gen failed', e?.message)
    }

    const updated = await prisma.payroll.update({
      where: { id: p.id },
      data: {
        status: 'PAID',
        payDate, payMethod: parsed.data.payMethod,
        bankTxNo: parsed.data.bankTxNo || null,
        voucherId,
      },
    })
    return {
      ...updated,
      voucherWarning: voucherId ? null : '凭证生成失败, 请手工补建',
    }
  })

  // 作废
  app.patch('/:id/void', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可作废' })
    const p = await prisma.payroll.findFirst({ where: { id: req.params.id, tenantId } })
    if (!p) return reply.status(404).send({ error: '不存在' })
    if (p.status === 'PAID') return reply.status(400).send({ error: '已发放不可作废, 请反审凭证 + 单独红冲' })
    const updated = await prisma.payroll.update({ where: { id: p.id }, data: { status: 'VOIDED' } })
    return updated
  })

  // 删除 (仅 DRAFT)
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板' })
    const p = await prisma.payroll.findFirst({ where: { id: req.params.id, tenantId } })
    if (!p) return reply.status(404).send({ error: '不存在' })
    if (p.status !== 'DRAFT') return reply.status(400).send({ error: '仅 DRAFT 可删除, 其他状态请作废' })
    await prisma.payroll.delete({ where: { id: p.id } })
    return { ok: true }
  })
}
