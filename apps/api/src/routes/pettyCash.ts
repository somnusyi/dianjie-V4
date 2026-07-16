/**
 * 备用金管理 (P1-3)
 *
 * 流程: 店长申请 → 财务批准 + 发放 → 店长使用 + 记开支 → 月底退余款 + 财务对账归档
 *
 * Endpoints:
 *   GET    /api/petty-cash                   列表 (财务看所有, 店长看自己店)
 *   GET    /api/petty-cash/:id               详情 (含开支明细)
 *   POST   /api/petty-cash                   店长申请 { storeId, month, requestedAmount, requestNote? }
 *   PATCH  /api/petty-cash/:id/approve       财务批 { approvedAmount }
 *   PATCH  /api/petty-cash/:id/pay           财务发放 { paymentMethod, accountId, bankTxNo?, paymentDate? }
 *   PATCH  /api/petty-cash/:id/reconcile     店长报账 { spentAmount, returnedAmount, reconcileNote? }
 *   PATCH  /api/petty-cash/:id/close         财务收退余款并关账 { returnAccountId?, returnDate? }
 *   PATCH  /api/petty-cash/:id/cancel        取消申请 (REQUESTED 时)
 *   POST   /api/petty-cash/:id/expenses      店长录开支 { date, category, amount, note?, attachments?, receiptId?, supplierId? }
 *   DELETE /api/petty-cash/:id/expenses/:eid 删除某条开支
 */
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { createVoucher } from '../services/voucher'
import { cashLedgerAccount, writeCashTransaction } from '../services/cashbook'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])
const STORE_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF_DIRECTOR'])
const PETTY_CASH_STATUSES = ['REQUESTED', 'APPROVED', 'PAID', 'RECONCILING', 'CLOSED', 'CANCELED'] as const
const paymentMethodSchema = z.enum(['现金', '转账', '招行'])
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份必须为 YYYY-MM')
const money = z.number().nonnegative().max(9_999_999_999.99, '金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')
const positiveMoney = money.refine(value => value > 0, '金额必须大于 0')

function parseBusinessDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T12:00:00+08:00`)
  if (Number.isNaN(date.getTime())) return null
  const [year, month, day] = value.split('-').map(Number)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null
  return date
}

function businessDateKey(date: Date | null | undefined): string {
  if (!date) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

async function logPettyCash(tx: any, opts: {
  tenantId: string
  userId: string
  action: string
  id: string
  month: string
  metadata?: Record<string, unknown>
}) {
  await tx.opLog.create({
    data: {
      tenantId: opts.tenantId, userId: opts.userId, action: opts.action,
      target: opts.month, targetId: opts.id, entityType: 'PettyCash',
      metadata: (opts.metadata || undefined) as any,
    },
  })
}

export const pettyCashRoutes: FastifyPluginAsync = async (app) => {

  // 列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权访问备用金' })
    }
    const parsed = z.object({
      month: monthSchema.optional(),
      status: z.enum(PETTY_CASH_STATUSES).optional(),
      storeId: z.string().optional(),
    }).strict().safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { month, status, storeId: queryStoreId } = parsed.data
    const where: any = { tenantId }
    if (month) where.month = month
    if (status) where.status = status
    // 店长仅看自己店
    if (STORE_ROLES.has(role)) {
      if (!storeId) return []
      where.storeId = storeId
    } else if (queryStoreId) {
      where.storeId = queryStoreId
    }
    const items = await prisma.pettyCash.findMany({
      where,
      include: {
        store: { select: { id: true, name: true } },
        _count: { select: { expenses: true } },
      },
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
    })
    return items
  })

  // 详情 (含开支)
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权访问备用金' })
    }
    const item = await prisma.pettyCash.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true } },
        expenses: { orderBy: { date: 'desc' } },
      },
    })
    if (!item) return reply.status(404).send({ error: '不存在' })
    if (STORE_ROLES.has(role) && item.storeId !== storeId) {
      return reply.status(403).send({ error: '非本店备用金' })
    }
    return item
  })

  // 店长申请
  const createSchema = z.object({
    storeId: z.string().optional(),    // 店长可不传, 默认自己店
    month: monthSchema,
    requestedAmount: positiveMoney,
    requestNote: z.string().trim().max(500).optional(),
  }).strict()
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '当前角色不可申请备用金' })
    }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const targetStoreId = parsed.data.storeId || storeId
    if (!targetStoreId) return reply.status(400).send({ error: '请指定 storeId' })
    if (STORE_ROLES.has(role) && targetStoreId !== storeId) {
      return reply.status(403).send({ error: '只能为自己店申请' })
    }
    // 校验 store 属于 tenant
    const store = await prisma.store.findFirst({ where: { id: targetStoreId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })
    try {
      const item = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash-create:${tenantId}:${targetStoreId}:${parsed.data.month}`}))`
        const created = await tx.pettyCash.create({
          data: {
            tenantId, storeId: targetStoreId,
            month: parsed.data.month,
            requestedAmount: parsed.data.requestedAmount,
            requestedById: userId,
            requestNote: parsed.data.requestNote || null,
            status: 'REQUESTED',
          },
        })
        await logPettyCash(tx, {
          tenantId, userId, id: created.id, month: created.month,
          action: `申请 ${store.name} ${created.month} 备用金 ¥${created.requestedAmount.toFixed(2)}`,
        })
        return created
      })
      return reply.status(201).send(item)
    } catch (e: any) {
      if (e?.code === 'P2002') return reply.status(409).send({ error: '本月该店已有备用金记录, 不可重复申请' })
      req.log.error({ err: e }, 'petty cash create failed')
      return reply.status(500).send({ error: '备用金申请失败，未保存任何变更' })
    }
  })

  // BUG#12: 拆分 批准 / 发放 两步
  // 财务批 (REQUESTED → APPROVED), 不立即扣款
  const approveSchema = z.object({
    approvedAmount: positiveMoney,
  }).strict()
  app.patch('/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可批' })
    const parsed = approveSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({
          where: { id, tenantId }, include: { store: { select: { name: true } } },
        })
        if (!item) throw httpError('不存在', 404)
        if (item.status === 'APPROVED' && item.approvedAmount?.equals(parsed.data.approvedAmount)) {
          return { item, duplicated: true }
        }
        if (item.status !== 'REQUESTED') throw httpError(`当前状态 ${item.status} 不可批准`, 409)
        const updated = await tx.pettyCash.update({
          where: { id: item.id },
          data: {
            status: 'APPROVED', approvedById: userId, approvedAt: new Date(),
            approvedAmount: parsed.data.approvedAmount,
          },
        })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `批准 ${item.store.name} ${item.month} 备用金 ¥${parsed.data.approvedAmount.toFixed(2)}`,
        })
        return { item: updated, duplicated: false }
      })
      return { ...result.item, duplicated: result.duplicated }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash approve failed')
      return reply.status(500).send({ error: '备用金批准失败，未保存任何变更' })
    }
  })

  // 财务发放 (APPROVED → PAID, 真扣款 + 建凭证)
  const paySchema = z.object({
    paymentMethod: paymentMethodSchema,
    accountId: z.string().min(1, '请选择资金账户'),
    bankTxNo: z.string().trim().max(100).optional(),
    paymentDate: z.string().optional(),
  }).strict()
  app.patch('/:id/pay', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可发放' })
    const parsed = paySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const requestedDate = parsed.data.paymentDate ? parseBusinessDate(parsed.data.paymentDate) : new Date()
    if (!requestedDate) return reply.status(400).send({ error: '发放日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (requestedDate > endOfToday) return reply.status(400).send({ error: '发放日期不能晚于今天' })

    let result: {
      item: any
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
      amount: number
      paidAt: Date
      duplicated: boolean
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({
          where: { id, tenantId }, include: { store: { select: { name: true } } },
        })
        if (!item) throw httpError('不存在', 404)
        const amount = Number(item.approvedAmount || 0)
        if (!Number.isFinite(amount) || amount <= 0) throw httpError('批准金额无效', 409)

        if (item.status === 'PAID') {
          const existingTx = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'PettyCashPay', refId: item.id, direction: -1 },
            include: { account: { select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true } } },
          })
          if (!existingTx) throw httpError('备用金已标记发放但缺少资金流水，请先由财务修复', 409)
          const same = item.paymentMethod === parsed.data.paymentMethod &&
            (item.bankTxNo || '') === (parsed.data.bankTxNo || '') &&
            existingTx.accountId === parsed.data.accountId &&
            (!parsed.data.paymentDate || businessDateKey(item.paidAt) === parsed.data.paymentDate)
          if (!same) throw httpError('备用金已按其他付款参数发放，不可覆盖', 409)
          return { item, account: existingTx.account, amount, paidAt: item.paidAt!, duplicated: true }
        }
        if (item.status !== 'APPROVED') {
          throw httpError(`当前状态 ${item.status} 不可发放 (需先 APPROVE)`, 409)
        }
        const account = await tx.cashAccount.findFirst({
          where: { id: parsed.data.accountId, tenantId, status: 'ACTIVE' },
          select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
        })
        if (!account) throw httpError('资金账户不存在或已停用', 404)
        if (parsed.data.paymentMethod === '现金' && account.type !== 'CASH') {
          throw httpError('现金发放必须选择库存现金账户', 409)
        }
        if (parsed.data.paymentMethod !== '现金' && account.type !== 'BANK') {
          throw httpError('转账发放必须选择银行账户', 409)
        }
        if (parsed.data.paymentMethod === '招行' && !account.cmbBindAccount) {
          throw httpError('招行发放必须选择已绑定招行账号的资金账户', 409)
        }
        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId: account.id, direction: -1, category: '备用金发放', amount,
          note: `${item.store.name} ${item.month} 备用金` +
            (parsed.data.bankTxNo ? ` · 流水 ${parsed.data.bankTxNo}` : ''),
          txDate: requestedDate, refType: 'PettyCashPay', refId: item.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const updated = await tx.pettyCash.update({
          where: { id: item.id },
          data: {
            status: 'PAID', paymentMethod: parsed.data.paymentMethod,
            bankTxNo: parsed.data.bankTxNo || null,
            paidAt: requestedDate, paidById: userId,
          },
          include: { store: { select: { name: true } } },
        })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `发放 ${item.store.name} ${item.month} 备用金 ¥${amount.toFixed(2)}`,
          metadata: { accountId: account.id, cashTransactionId: cashTx.id },
        })
        return { item: updated, account, amount, paidAt: requestedDate, duplicated: false }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash pay failed')
      return reply.status(500).send({ error: '备用金发放失败，未保存任何变更' })
    }

    const ledger = cashLedgerAccount(result.account)
    let voucherId: string | null = null
    try {
      voucherId = await createVoucher({
        tenantId, date: result.paidAt,
        summary: `${result.item.month} 备用金发放 (${result.item.store.name})`,
        sourceType: 'PettyCashPay', sourceId: result.item.id,
        entries: [
          { accountCode: '122101', accountName: '备用金', debit: result.amount,
            summary: `${result.item.store.name} ${result.item.month} 备用金发放` },
          { accountCode: ledger.code, accountName: ledger.name, credit: result.amount },
        ],
        createdById: userId, lockMode: 'auto', autoPost: true,
      })
    } catch (error: any) {
      req.log.warn({ err: error }, 'petty cash pay voucher failed after payment')
    }
    return {
      ...result.item, duplicated: result.duplicated, voucherId,
      voucherWarning: voucherId ? null : '备用金已发放但凭证生成失败，可用相同参数重试补建',
    }
  })

  // 店长报账 (月底退余款 + 申报花销)
  const reconcileSchema = z.object({
    spentAmount: money,
    returnedAmount: money,
    reconcileNote: z.string().trim().max(500).optional(),
  }).strict()
  app.patch('/:id/reconcile', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '当前角色不可提交备用金报账' })
    }
    const parsed = reconcileSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({
          where: { id, tenantId }, include: { store: { select: { name: true } } },
        })
        if (!item) throw httpError('不存在', 404)
        if (STORE_ROLES.has(role) && item.storeId !== storeId) throw httpError('非本店', 403)
        if (item.status === 'RECONCILING' && item.spentAmount?.equals(parsed.data.spentAmount) &&
          item.returnedAmount?.equals(parsed.data.returnedAmount)) {
          return { item, duplicated: true }
        }
        if (item.status !== 'PAID') throw httpError('仅已发放可报账', 409)
        const sum = await tx.pettyCashExpense.aggregate({
          where: { pettyCashId: item.id }, _sum: { amount: true },
        })
        const actualSpent = sum._sum.amount || new Prisma.Decimal(0)
        const approved = item.approvedAmount || new Prisma.Decimal(0)
        if (!actualSpent.equals(parsed.data.spentAmount)) {
          throw httpError(
            `申报花销 ${parsed.data.spentAmount.toFixed(2)} 与已录开支 ${actualSpent.toFixed(2)} 不一致`, 409,
          )
        }
        const expectedReturn = approved.minus(actualSpent)
        if (expectedReturn.isNegative()) {
          throw httpError(`已录开支 ${actualSpent.toFixed(2)} 超过批准额 ${approved.toFixed(2)}`, 409)
        }
        if (!expectedReturn.equals(parsed.data.returnedAmount)) {
          throw httpError(
            `退余款应为 ${expectedReturn.toFixed(2)}（批准 ${approved.toFixed(2)} - 开支 ${actualSpent.toFixed(2)}）`, 409,
          )
        }
        const updated = await tx.pettyCash.update({
          where: { id: item.id },
          data: {
            status: 'RECONCILING', spentAmount: actualSpent, returnedAmount: expectedReturn,
            reconcileNote: parsed.data.reconcileNote || null,
            reconciledById: userId, reconciledAt: new Date(),
          },
        })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `提交 ${item.store.name} ${item.month} 备用金报账：开支 ¥${actualSpent.toFixed(2)}，退余 ¥${expectedReturn.toFixed(2)}`,
        })
        return { item: updated, duplicated: false }
      })
      return { ...result.item, duplicated: result.duplicated }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash reconcile failed')
      return reply.status(500).send({ error: '备用金报账失败，未保存任何变更' })
    }
  })

  // 财务关账 (RECONCILING → CLOSED)
  const closeSchema = z.object({
    returnAccountId: z.string().min(1).optional(),
    returnDate: z.string().optional(),
  }).strict()
  app.patch('/:id/close', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可关账' })
    const parsed = closeSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const requestedDate = parsed.data.returnDate ? parseBusinessDate(parsed.data.returnDate) : new Date()
    if (!requestedDate) return reply.status(400).send({ error: '退余款日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (requestedDate > endOfToday) return reply.status(400).send({ error: '退余款日期不能晚于今天' })

    let result: {
      item: any
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null } | null
      approved: number
      spent: number
      returned: number
      closeDate: Date
      duplicated: boolean
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({
          where: { id, tenantId }, include: { store: { select: { name: true } } },
        })
        if (!item) throw httpError('不存在', 404)
        const approvedD = item.approvedAmount || new Prisma.Decimal(0)
        const spentD = item.spentAmount || new Prisma.Decimal(0)
        const returnedD = item.returnedAmount || new Prisma.Decimal(0)
        if (!spentD.plus(returnedD).equals(approvedD)) {
          throw httpError('备用金报账金额不平，不能关账', 409)
        }
        const actualExpenses = await tx.pettyCashExpense.aggregate({
          where: { pettyCashId: item.id }, _sum: { amount: true },
        })
        if (!(actualExpenses._sum.amount || new Prisma.Decimal(0)).equals(spentD)) {
          throw httpError('开支明细已变化，与报账花销不一致，不能关账', 409)
        }

        let account: typeof result.account = null
        if (item.status === 'CLOSED') {
          const existingReturn = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'PettyCashReturn', refId: item.id, direction: 1 },
            include: { account: { select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true } } },
          })
          if (returnedD.gt(0)) {
            if (!existingReturn) throw httpError('备用金已关账但缺少退余款资金流水，请先由财务修复', 409)
            if (existingReturn.accountId !== parsed.data.returnAccountId ||
              (parsed.data.returnDate && businessDateKey(existingReturn.txDate) !== parsed.data.returnDate)) {
              throw httpError('备用金已按其他退余参数关账，不可覆盖', 409)
            }
            account = existingReturn.account
          } else if (parsed.data.returnAccountId) {
            throw httpError('本单无退余款，无需选择收款账户', 409)
          }
          return {
            item, account, approved: Number(approvedD), spent: Number(spentD), returned: Number(returnedD),
            closeDate: existingReturn?.txDate || item.updatedAt, duplicated: true,
          }
        }
        if (item.status !== 'RECONCILING') throw httpError('仅 RECONCILING 可关账', 409)

        let returnTx: { id: string } | null = null
        if (returnedD.gt(0)) {
          if (!parsed.data.returnAccountId) throw httpError('有退余款时必须选择实际收款账户', 400)
          account = await tx.cashAccount.findFirst({
            where: { id: parsed.data.returnAccountId, tenantId, status: 'ACTIVE' },
            select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
          })
          if (!account) throw httpError('退余款收款账户不存在或已停用', 404)
          if (!['CASH', 'BANK'].includes(account.type)) {
            throw httpError('备用金退余款只能存入现金或银行账户', 409)
          }
          returnTx = await writeCashTransaction(tx, {
            tenantId, accountId: account.id, direction: 1, category: '备用金退余',
            amount: Number(returnedD), note: `${item.store.name} ${item.month} 备用金退余`,
            txDate: requestedDate, refType: 'PettyCashReturn', refId: item.id, createdById: userId,
          })
          if (!returnTx) throw new Error('退余款资金账户写入失败')
        } else if (parsed.data.returnAccountId) {
          throw httpError('本单无退余款，无需选择收款账户', 400)
        }
        const updated = await tx.pettyCash.update({ where: { id: item.id }, data: { status: 'CLOSED' } })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `关账 ${item.store.name} ${item.month} 备用金：开支 ¥${spentD.toFixed(2)}，退余 ¥${returnedD.toFixed(2)}`,
          metadata: returnTx && account ? { returnAccountId: account.id, cashTransactionId: returnTx.id } : undefined,
        })
        return {
          item: { ...updated, store: item.store }, account,
          approved: Number(approvedD), spent: Number(spentD), returned: Number(returnedD),
          closeDate: requestedDate, duplicated: false,
        }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash close failed')
      return reply.status(500).send({ error: '备用金关账失败，未保存任何变更' })
    }

    const entries: any[] = []
    if (result.spent > 0) entries.push({
      accountCode: '560125', accountName: '销售费用-其他', debit: result.spent,
      summary: `${result.item.month} 备用金报销 (${result.item.store.name}) — 可手工拆细`,
    })
    if (result.returned > 0 && result.account) {
      const ledger = cashLedgerAccount(result.account)
      entries.push({ accountCode: ledger.code, accountName: ledger.name, debit: result.returned, summary: '退余款入账' })
    }
    entries.push({ accountCode: '122101', accountName: '备用金', credit: result.approved })
    let voucherId: string | null = null
    try {
      voucherId = await createVoucher({
        tenantId, date: result.closeDate,
        summary: `${result.item.month} 备用金关账 (${result.item.store.name})`,
        sourceType: 'PettyCashClose', sourceId: result.item.id,
        entries, createdById: userId, lockMode: 'auto', autoPost: true,
      })
    } catch (error: any) {
      req.log.warn({ err: error }, 'petty cash close voucher failed after close')
    }
    return {
      ...result.item, duplicated: result.duplicated, voucherId,
      voucherWarning: voucherId ? null : '备用金已关账但凭证生成失败，可用相同参数重试补建',
    }
  })

  // 取消申请 (REQUESTED 时)
  app.patch('/:id/cancel', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({ where: { id, tenantId } })
        if (!item) throw httpError('不存在', 404)
        if (!FINANCE_ROLES.has(role) && item.requestedById !== userId) {
          throw httpError('仅申请人或财务可取消', 403)
        }
        if (item.status === 'CANCELED') return { item, duplicated: true }
        if (item.status !== 'REQUESTED') throw httpError('仅 REQUESTED 可取消', 409)
        const updated = await tx.pettyCash.update({ where: { id: item.id }, data: { status: 'CANCELED' } })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month, action: `取消 ${item.month} 备用金申请`,
        })
        return { item: updated, duplicated: false }
      })
      return { ...result.item, duplicated: result.duplicated }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash cancel failed')
      return reply.status(500).send({ error: '备用金取消失败，未保存任何变更' })
    }
  })

  // 录开支
  const expenseSchema = z.object({
    date: z.string(),
    category: z.string().trim().min(1).max(80),
    amount: positiveMoney,
    note: z.string().trim().max(500).optional(),
    attachments: z.array(z.string().trim().min(1).max(500)).max(10).optional().default([]),
    receiptId: z.string().max(100).optional(),
    supplierId: z.string().max(100).optional(),
  }).strict()
  app.post('/:id/expenses', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '当前角色不可录入备用金开支' })
    }
    const parsed = expenseSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const expenseDate = parseBusinessDate(parsed.data.date)
    if (!expenseDate) return reply.status(400).send({ error: '开支日期无效' })
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
    if (expenseDate > endOfToday) return reply.status(400).send({ error: '开支日期不能晚于今天' })
    try {
      const exp = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({ where: { id, tenantId } })
        if (!item) throw httpError('备用金不存在', 404)
        if (STORE_ROLES.has(role) && item.storeId !== storeId) throw httpError('非本店', 403)
        if (item.status !== 'PAID') throw httpError('仅已发放且未提交报账的备用金可录开支', 409)
        if (parsed.data.date.slice(0, 7) !== item.month) {
          throw httpError(`开支日期必须属于备用金月份 ${item.month}`, 409)
        }
        if (parsed.data.receiptId) {
          const receipt = await tx.receipt.findFirst({
            where: { id: parsed.data.receiptId, tenantId, storeId: item.storeId }, select: { id: true },
          })
          if (!receipt) throw httpError('关联收货单不存在或不属于本门店', 404)
        }
        if (parsed.data.supplierId) {
          const supplier = await tx.supplier.findFirst({
            where: { id: parsed.data.supplierId, tenantId }, select: { id: true },
          })
          if (!supplier) throw httpError('关联供应商不存在', 404)
        }
        const aggregate = await tx.pettyCashExpense.aggregate({
          where: { pettyCashId: item.id }, _sum: { amount: true },
        })
        const nextTotal = (aggregate._sum.amount || new Prisma.Decimal(0)).plus(parsed.data.amount)
        const approved = item.approvedAmount || new Prisma.Decimal(0)
        if (nextTotal.gt(approved)) {
          throw httpError(`开支累计 ${nextTotal.toFixed(2)} 超过批准额 ${approved.toFixed(2)}`, 409)
        }
        const created = await tx.pettyCashExpense.create({
          data: {
            pettyCashId: item.id, date: expenseDate,
            category: parsed.data.category, amount: parsed.data.amount,
            note: parsed.data.note || null, attachments: parsed.data.attachments,
            receiptId: parsed.data.receiptId || null, supplierId: parsed.data.supplierId || null,
            createdById: userId,
          },
        })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `录入 ${item.month} 备用金开支 ¥${parsed.data.amount.toFixed(2)} (${parsed.data.category})`,
          metadata: { expenseId: created.id },
        })
        return created
      })
      return reply.status(201).send(exp)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash expense create failed')
      return reply.status(500).send({ error: '备用金开支保存失败，未保存任何变更' })
    }
  })

  // 删除开支
  app.delete('/:id/expenses/:eid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, storeId, role } = req.user
    if (!FINANCE_ROLES.has(role) && !STORE_ROLES.has(role)) {
      return reply.status(403).send({ error: '当前角色不可删除备用金开支' })
    }
    try {
      return await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${id}`}))`
        const item = await tx.pettyCash.findFirst({ where: { id, tenantId } })
        if (!item) throw httpError('备用金不存在', 404)
        if (STORE_ROLES.has(role) && item.storeId !== storeId) throw httpError('非本店', 403)
        if (item.status !== 'PAID') throw httpError('仅已发放且未提交报账的备用金可删除开支', 409)
        const expense = await tx.pettyCashExpense.findFirst({
          where: { id: req.params.eid, pettyCashId: item.id }, select: { id: true, amount: true, category: true },
        })
        if (!expense) throw httpError('开支不存在', 404)
        await tx.pettyCashExpense.delete({ where: { id: expense.id } })
        await logPettyCash(tx, {
          tenantId, userId, id: item.id, month: item.month,
          action: `删除 ${item.month} 备用金开支 ¥${expense.amount.toFixed(2)} (${expense.category})`,
          metadata: { expenseId: expense.id },
        })
        return { ok: true }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'petty cash expense delete failed')
      return reply.status(500).send({ error: '备用金开支删除失败，未保存任何变更' })
    }
  })
}
