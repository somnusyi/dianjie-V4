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
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { createVoucher } from '../services/voucher'
import { cashLedgerAccount, writeCashTransaction } from '../services/cashbook'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])

// 工资 → 会计科目映射 (按好会计真实科目表, 餐饮门店员工默认走销售费用)
// 客户实际科目表 (科目表.xlsx 自查):
//   560101 销售人员职工薪酬 (餐饮店员/厨师/服务员 — 多数场景)
//   560201 管理人员职工薪酬 (管理岗 — 后续可加 item.isMgmt 区分)
//   221104 应付社会保险费 (末级, 非 2211 一级)
//   222121 应交个人所得税 (末级, 非 2221 一级)
const ACCT = {
  expenseGross: { code: '560101', name: '销售人员职工薪酬' },
  socialSec:    { code: '221104', name: '应付社会保险费' },
  tax:          { code: '222121', name: '应交个人所得税' },
}

const money = (max: number) => z.number().nonnegative().max(max)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份必须为 YYYY-MM')

function parseBusinessDate(value: string | undefined): Date | null {
  if (!value) return new Date()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return null
  const parts = value.split('-').map(Number)
  if (date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2]) return null
  return date
}

function businessDateKey(date: Date | null | undefined): string {
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const itemSchema = z.object({
  employeeName: z.string().trim().min(1).max(80),
  position: z.string().trim().max(80).optional(),
  baseSalary: money(99_999_999.99).optional(),
  bonus: money(99_999_999.99).optional(),
  overtime: money(99_999_999.99).optional(),
  deductSocialSec: money(99_999_999.99).optional(),
  deductTax: money(99_999_999.99).optional(),
  deductOther: money(99_999_999.99).optional(),
  netAmount: money(99_999_999.99),
  note: z.string().trim().max(500).optional(),
}).strict()

const createSchema = z.object({
  storeId: z.string(),
  month: monthSchema,
  items: z.array(itemSchema).min(1, '至少 1 个员工').max(1000, '单张工资单最多 1000 人'),
  note: z.string().trim().max(500).optional(),
}).strict()

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
    const sum = (values: number[]) => values.reduce(
      (total, value) => total.plus(new Prisma.Decimal(value)), new Prisma.Decimal(0),
    )
    const totalGross = sum(items.flatMap(i => [i.baseSalary || 0, i.bonus || 0, i.overtime || 0]))
    const totalNet = sum(items.map(i => i.netAmount))
    const totalSocialSec = sum(items.map(i => i.deductSocialSec || 0))
    const totalTax = sum(items.map(i => i.deductTax || 0))
    const maxTotal = new Prisma.Decimal('9999999999.99')
    if (totalNet.lte(0)) return reply.status(400).send({ error: '实发合计必须大于 0' })
    if ([totalGross, totalNet, totalSocialSec, totalTax].some(value => value.gt(maxTotal))) {
      return reply.status(400).send({ error: '工资汇总金额超出系统上限' })
    }

    try {
      const payroll = await prisma.payroll.create({
        data: {
          tenantId, storeId: parsed.data.storeId, month: parsed.data.month,
          totalGross: totalGross.gt(0) ? totalGross : null,
          totalNet,
          totalSocialSec: totalSocialSec.gt(0) ? totalSocialSec : null,
          totalTax: totalTax.gt(0) ? totalTax : null,
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
    payMethod: z.enum(['现金', '转账', '招行']),
    accountId: z.string().min(1, '请选择资金账户'),
    bankTxNo: z.string().trim().max(100).optional(),
    payDate: z.string().optional(),  // YYYY-MM-DD
  }).strict()
  app.patch('/:id/mark-paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可发放' })
    const parsed = markPaidSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })

    const payDate = parseBusinessDate(parsed.data.payDate)
    if (!payDate) return reply.status(400).send({ error: '发放日期无效' })
    const tomorrow = new Date()
    tomorrow.setHours(23, 59, 59, 999)
    if (payDate > tomorrow) return reply.status(400).send({ error: '发放日期不能晚于今天' })

    let result: {
      duplicated: boolean
      payroll: any
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
      totalGross: number
      totalNet: number
      totalSocialSec: number
      totalTax: number
      payDate: Date
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${id}`}))`
        const p = await tx.payroll.findFirst({
          where: { id, tenantId },
          include: {
            store: { select: { name: true } },
            items: { select: { deductOther: true } },
          },
        })
        if (!p) throw Object.assign(new Error('工资单不存在'), { statusCode: 404 })

        const totalGrossD = p.totalGross || p.totalNet
        const totalNetD = p.totalNet
        const totalSocialSecD = p.totalSocialSec || new Prisma.Decimal(0)
        const totalTaxD = p.totalTax || new Prisma.Decimal(0)
        const totalOtherD = p.items.reduce(
          (total, item) => total.plus(item.deductOther || 0), new Prisma.Decimal(0),
        )
        if (totalOtherD.gt(0)) {
          throw Object.assign(
            new Error('工资单含“其他扣项”，尚未配置对应会计科目，请确认口径后再发放'),
            { statusCode: 409 },
          )
        }
        const credits = totalNetD.plus(totalSocialSecD).plus(totalTaxD)
        if (!totalGrossD.equals(credits)) {
          throw Object.assign(
            new Error(`工资汇总不平：应发 ${totalGrossD.toFixed(2)}，实发+社保+个税 ${credits.toFixed(2)}`),
            { statusCode: 409 },
          )
        }
        const totals = {
          totalGross: Number(totalGrossD), totalNet: Number(totalNetD),
          totalSocialSec: Number(totalSocialSecD), totalTax: Number(totalTaxD),
        }
        if (p.status === 'PAID') {
          const existingTx = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'Payroll', refId: p.id },
            include: {
              account: { select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true } },
            },
          })
          if (!existingTx) {
            throw Object.assign(new Error('工资已标记发放但缺少资金流水，请先由财务修复'), { statusCode: 409 })
          }
          const sameRequest = p.payMethod === parsed.data.payMethod &&
            businessDateKey(p.payDate) === businessDateKey(payDate) &&
            (p.bankTxNo || '') === (parsed.data.bankTxNo || '') &&
            existingTx.accountId === parsed.data.accountId
          if (!sameRequest) {
            throw Object.assign(new Error('工资已按其他付款参数发放，不可覆盖'), { statusCode: 409 })
          }
          return { duplicated: true, payroll: p, account: existingTx.account, ...totals, payDate: p.payDate! }
        }
        if (p.status !== 'APPROVED') {
          throw Object.assign(new Error(`当前状态 ${p.status}，仅 APPROVED 可发放`), { statusCode: 409 })
        }
        const account = await tx.cashAccount.findFirst({
          where: { id: parsed.data.accountId, tenantId, status: 'ACTIVE' },
          select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
        })
        if (!account) throw Object.assign(new Error('资金账户不存在或已停用'), { statusCode: 404 })
        if (parsed.data.payMethod === '现金' && account.type !== 'CASH') {
          throw Object.assign(new Error('现金发放必须选择库存现金账户'), { statusCode: 409 })
        }
        if (parsed.data.payMethod !== '现金' && account.type !== 'BANK') {
          throw Object.assign(new Error('转账发放必须选择银行账户'), { statusCode: 409 })
        }
        if (parsed.data.payMethod === '招行' && !account.cmbBindAccount) {
          throw Object.assign(new Error('招行发放必须选择已绑定招行账号的资金账户'), { statusCode: 409 })
        }
        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId: account.id, direction: -1, category: '工资发放',
          amount: totals.totalNet, note: `${p.month} 工资 (${p.store.name})` +
            (parsed.data.bankTxNo ? ` 流水 ${parsed.data.bankTxNo}` : ''),
          txDate: payDate, refType: 'Payroll', refId: p.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const updated = await tx.payroll.update({
          where: { id: p.id },
          data: {
            status: 'PAID', payDate, payMethod: parsed.data.payMethod,
            bankTxNo: parsed.data.bankTxNo || null,
          },
          include: { store: { select: { name: true } } },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `发放 ${p.month} 工资 ¥${totals.totalNet.toFixed(2)} (${p.store.name})`,
            target: p.month, targetId: p.id, entityType: 'Payroll',
            metadata: { accountId: account.id, cashTransactionId: cashTx.id } as any,
          },
        })
        return { duplicated: false, payroll: updated, account, ...totals, payDate }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'payroll mark-paid failed')
      return reply.status(500).send({ error: '工资发放失败，未保存任何变更' })
    }

    const p = result.payroll
    const { totalGross, totalNet, totalSocialSec, totalTax } = result
    const ledgerAccount = cashLedgerAccount(result.account)

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
      // 银行用末级科目 (100201=中行/100202=建行), 默认中行
      accountCode: ledgerAccount.code,
      accountName: ledgerAccount.name,
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

    let voucherId: string | null = p.voucherId || null
    try {
      voucherId = voucherId || await createVoucher({
        tenantId,
        date: result.payDate,
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
      req.log.warn({ err: e }, 'payroll voucher generation failed after payment')
    }

    let updated = p
    if (voucherId && p.voucherId !== voucherId) {
      updated = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${p.id}`}))`
        return tx.payroll.update({ where: { id: p.id }, data: { voucherId } })
      })
    }
    return {
      ...updated,
      duplicated: result.duplicated,
      voucherWarning: voucherId ? null : '工资已发放但凭证生成失败，可用相同参数重试补建或在失败队列处理',
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
