import { FastifyPluginAsync } from 'fastify'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { cashLedgerAccount, writeCashTransaction } from '../services/cashbook'
import { nextBusinessNo } from '../services/purchaseOrderIntegrity'
import { createVoucher } from '../services/voucher'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN'])
const PAY_METHODS = ['BANK_TRANSFER', 'ALIPAY', 'WECHAT', 'CASH'] as const
const PAY_STATUSES = ['UNPAID', 'PAYING', 'PAID', 'FAILED'] as const
const ACCOUNT_TYPE_BY_METHOD: Record<typeof PAY_METHODS[number], 'BANK' | 'ALIPAY' | 'WECHAT' | 'CASH'> = {
  BANK_TRANSFER: 'BANK', ALIPAY: 'ALIPAY', WECHAT: 'WECHAT', CASH: 'CASH',
}

const moneySchema = z.number()
  .positive('金额必须大于 0')
  .max(9_999_999_999.99, '金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '金额最多保留两位小数')
const optionalText = (max: number) => z.string().trim().max(max).optional()
const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const date = dayjs(value)
  return date.isValid() && date.format('YYYY-MM-DD') === value
}, '日期无效')

const listSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(PAY_STATUSES).optional(),
}).strict()

const createSchema = z.object({
  reconciliationId: z.string().trim().min(1, '请选择对账单').max(100),
  amount: moneySchema,
  method: z.enum(PAY_METHODS),
  note: optionalText(1000),
}).strict()

const markPaidSchema = z.object({
  accountId: z.string().trim().min(1, '请选择实际付款账户').max(100),
  paidAt: businessDateSchema,
  bankTxNo: optionalText(100),
  note: optionalText(500),
}).strict()

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function isUniqueConflict(error: any) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || null
}

function paidNote(paymentNo: string, supplierName: string, note: string | null) {
  return `${paymentNo} ${supplierName}${note ? ` · ${note}` : ''}`
}

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权查看付款单' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    }
    const parsed = listSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { page, pageSize, status } = parsed.data
    const where: Prisma.PaymentWhereInput = { tenantId }
    if (status) where.status = status
    if (isSupplierRole(role)) where.supplierId = supplierId
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          supplier: { select: { name: true, bankAccount: true } },
          reconciliation: { select: { no: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.payment.count({ where }),
    ])
    return { items, total, page, pageSize }
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = createSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { reconciliationId, amount, method } = parsed.data
    const note = normalizedText(parsed.data.note)

    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-create:${reconciliationId}`}))`
        const recon = await tx.reconciliation.findFirst({
          where: { id: reconciliationId, tenantId },
          include: { payments: { orderBy: { createdAt: 'asc' }, take: 1 } },
        })
        if (!recon) throw httpError('对账单不存在', 404)

        const requestedAmount = new Prisma.Decimal(amount).toDecimalPlaces(2)
        const existing = recon.payments[0]
        if (existing) {
          const same = existing.amount.equals(requestedAmount)
            && existing.method === method
            && normalizedText(existing.note) === note
          if (same) return { payment: existing, duplicated: true }
          throw httpError('该对账单已生成付款单，且付款参数不同', 409)
        }
        if (recon.status !== 'APPROVED') {
          throw httpError(`对账单当前状态 ${recon.status}，不可生成付款单`, 409)
        }
        if (!recon.totalAmount.equals(requestedAmount)) {
          throw httpError(`金额与对账单不符 (¥${recon.totalAmount.toFixed(2)})`, 400)
        }

        const ym = dayjs().format('YYYYMM')
        const prefix = `PY${ym}`
        const latest = await tx.payment.findFirst({
          where: { tenantId, no: { startsWith: prefix } }, orderBy: { no: 'desc' }, select: { no: true },
        })
        const floor = Number(latest?.no.slice(prefix.length) || 0)
        const no = await nextBusinessNo(
          tx, tenantId, 'PAYMENT', ym, 'PY', Number.isFinite(floor) ? floor : 0,
        )
        const payment = await tx.payment.create({
          data: {
            tenantId, no, supplierId: recon.supplierId, reconciliationId,
            amount: requestedAmount, method, status: 'UNPAID', note,
          },
        })
        const changed = await tx.reconciliation.updateMany({
          where: { id: recon.id, tenantId, status: 'APPROVED' },
          data: { status: 'PAYMENT_GENERATED' },
        })
        if (changed.count !== 1) throw httpError('对账单状态已变化，请刷新后重试', 409)
        await tx.opLog.create({
          data: {
            tenantId, userId, role, action: `创建付款单 ${no}`, target: no,
            entityType: 'Payment', targetId: payment.id,
            metadata: { reconciliationId, amount: requestedAmount.toFixed(2), method },
          },
        })
        return { payment, duplicated: false }
      })
      return reply.status(result.duplicated ? 200 : 201).send({ ...result.payment, duplicated: result.duplicated })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (isUniqueConflict(error)) {
        return reply.status(409).send({ error: '该对账单已生成付款单或单号发生冲突，请刷新后重试' })
      }
      req.log.error({ err: error }, 'payment create failed')
      return reply.status(500).send({ error: '创建付款单失败，未保存任何变更' })
    }
  })

  app.patch('/:id/paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = markPaidSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { accountId, paidAt } = parsed.data
    const bankTxNo = normalizedText(parsed.data.bankTxNo)
    const note = normalizedText(parsed.data.note)
    if (dayjs(paidAt).isAfter(dayjs(), 'day')) return reply.status(400).send({ error: '付款日期不得晚于今天' })

    let result: {
      payment: any
      supplierName: string
      account: { id: string; name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
      paidDate: Date
      duplicated: boolean
      cashTransactionId: string
    }
    try {
      result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-paid:${id}`}))`
        if (bankTxNo) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-reference:${tenantId}:${bankTxNo}`}))`
        }
        const rows = await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "payments"
          WHERE "id" = ${id} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `) as Array<{ id: string }>
        if (rows.length !== 1) throw httpError('付款单不存在', 404)
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id }, include: { supplier: { select: { name: true } }, reconciliation: { select: { status: true } } },
        })
        if (payment.method !== 'CASH' && !bankTxNo) {
          throw httpError('非现金付款必须填写实际支付流水号', 400)
        }
        const expectedAccountType = ACCOUNT_TYPE_BY_METHOD[payment.method]
        const account = await tx.cashAccount.findFirst({
          where: { id: accountId, tenantId, status: 'ACTIVE' },
          select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
        })
        if (!account) throw httpError('付款账户不存在或已停用', 409)
        if (account.type !== expectedAccountType) {
          throw httpError(`付款方式与资金账户类型不匹配，应选择 ${expectedAccountType} 账户`, 400)
        }
        const paidDate = new Date(`${paidAt}T00:00:00.000+08:00`)
        const expectedNote = paidNote(payment.no, payment.supplier.name, note)

        if (payment.status === 'PAID') {
          const cashTx = await tx.cashTransaction.findFirst({
            where: { tenantId, refType: 'Payment', refId: payment.id },
            orderBy: { createdAt: 'asc' },
          })
          if (!cashTx) throw httpError('付款单已完成但缺少资金流水，请联系管理员修复', 409)
          const same = cashTx.accountId === accountId
            && dayjs(cashTx.txDate).format('YYYY-MM-DD') === paidAt
            && normalizedText(payment.bankTxNo) === bankTxNo
            && normalizedText(cashTx.note) === expectedNote
          if (!same) throw httpError('付款单已完成，重复请求参数与原付款记录不一致', 409)
          return {
            payment, supplierName: payment.supplier.name, account, paidDate,
            duplicated: true, cashTransactionId: cashTx.id,
          }
        }
        if (payment.status !== 'UNPAID') {
          throw httpError(`付款单当前状态 ${payment.status}，不可标记付款`, 409)
        }
        if (!payment.reconciliationId || payment.reconciliation?.status !== 'PAYMENT_GENERATED') {
          throw httpError('关联对账单状态异常，禁止付款', 409)
        }
        if (bankTxNo) {
          const duplicateReference = await tx.payment.findFirst({
            where: { tenantId, bankTxNo, id: { not: payment.id } }, select: { id: true, no: true },
          })
          if (duplicateReference) throw httpError(`支付流水号已被付款单 ${duplicateReference.no} 使用`, 409)
        }

        const cashTx = await writeCashTransaction(tx, {
          tenantId, accountId, direction: -1, category: '供应商付款',
          amount: Number(payment.amount), note: expectedNote, txDate: paidDate,
          refType: 'Payment', refId: payment.id, createdById: userId,
        })
        if (!cashTx) throw new Error('资金账户写入失败')
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'PAID', paidAt: paidDate, bankTxNo },
        })
        const reconciled = await tx.reconciliation.updateMany({
          where: { id: payment.reconciliationId, tenantId, status: 'PAYMENT_GENERATED' },
          data: { status: 'DONE' },
        })
        if (reconciled.count !== 1) throw httpError('对账单状态已变化，付款未保存', 409)
        await tx.opLog.create({
          data: {
            tenantId, userId, role, action: `完成供应商付款 ${payment.no}`, target: payment.no,
            entityType: 'Payment', targetId: payment.id,
            metadata: { accountId, cashTransactionId: cashTx.id, bankTxNo, paidAt, amount: payment.amount.toFixed(2) },
          },
        })
        return {
          payment: { ...updated, supplier: payment.supplier }, supplierName: payment.supplier.name,
          account, paidDate, duplicated: false, cashTransactionId: cashTx.id,
        }
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (isUniqueConflict(error)) return reply.status(409).send({ error: '支付流水号已使用，请核对后重试' })
      req.log.error({ err: error }, 'payment mark-paid failed')
      return reply.status(500).send({ error: '付款执行失败，未保存任何变更' })
    }

    let voucherId: string | null = null
    let voucherWarning: string | null = null
    try {
      const ledger = cashLedgerAccount(result.account)
      voucherId = await createVoucher({
        tenantId, date: result.paidDate,
        summary: `付款 ${result.payment.no} ${result.supplierName}`,
        sourceType: 'Payment', sourceId: result.payment.id,
        entries: [
          { accountCode: '2202', accountName: '应付账款', debit: Number(result.payment.amount), summary: `应付 ${result.supplierName}` },
          { accountCode: ledger.code, accountName: ledger.name, credit: Number(result.payment.amount) },
        ],
        createdById: userId, autoPost: true,
      })
      if (!voucherId) voucherWarning = '凭证生成失败，请在失败队列补建或用相同参数重试'
    } catch (error: any) {
      req.log.warn({ err: error }, 'payment voucher generation failed after payment')
      voucherWarning = '付款已完成，但凭证生成失败；可用相同参数重试补建或在失败队列处理'
    }

    return reply.send({
      message: '付款完成', duplicated: result.duplicated,
      cashTransactionId: result.cashTransactionId, voucherId, voucherWarning,
    })
  })
}
