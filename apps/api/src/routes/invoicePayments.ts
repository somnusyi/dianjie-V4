/** 发票分次付款：预占、实际资金确认、失败/取消与凭证恢复。 */
import dayjs from 'dayjs'
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { resignOssUrl } from './upload'
import {
  cancelInvoicePayment,
  confirmInvoicePaymentSuccess,
  createInvoicePayment,
  failInvoicePayment,
} from '../services/invoicePaymentIntegrity'

const FINANCE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])
const PAYMENT_METHODS = ['cmb', 'manual', 'wechat', 'alipay', 'cash'] as const

const moneySchema = z.number().positive('付款金额必须大于 0')
  .max(9_999_999_999.99, '付款金额超出系统上限')
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, '付款金额最多保留 2 位小数')
const optionalText = (max: number) => z.string().trim().max(max).optional()
const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const date = dayjs(value)
    return date.isValid() && date.format('YYYY-MM-DD') === value
  }, '日期无效')

export const invoicePaymentCreateSchema = z.object({
  invoiceId: z.string().trim().min(1, '请选择发票').max(100),
  amount: moneySchema,
  paymentMethod: z.enum(PAYMENT_METHODS).default('manual'),
  requestId: z.string().uuid('付款操作号无效').optional(),
  note: optionalText(500),
}).strict()

export const invoicePaymentConfirmSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('SUCCESS'),
    accountId: z.string().trim().min(1, '请选择实际付款账户').max(100),
    paidAt: businessDateSchema,
    bankTxNo: optionalText(100),
    note: optionalText(500),
  }).strict(),
  z.object({
    status: z.literal('FAILED'),
    failReason: z.string().trim().min(1, '付款失败必须填写原因').max(500),
  }).strict(),
])

const cancelSchema = z.object({ reason: optionalText(500) }).strict()
const listSchema = z.object({ invoiceId: z.string().trim().min(1).max(100).optional() }).strict()

function sendError(req: any, reply: any, error: any, fallback: string) {
  if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return reply.status(409).send({ error: '付款操作号或支付流水号已使用，请核对后重试' })
  }
  req.log.error({ err: error }, fallback)
  return reply.status(500).send({ error: `${fallback}，未保存任何变更` })
}

export const invoicePaymentRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/payable', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) return reply.status(403).send({ error: '无权限' })
    if (isSupplierRole(role) && !supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
    const where: Prisma.InvoiceWhereInput = { tenantId, status: 'VERIFIED', fullyPaidAt: null }
    if (isSupplierRole(role)) where.supplierId = supplierId
    const invoices = await prisma.invoice.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        receipts: {
          select: {
            id: true, no: true, totalAmount: true, deliveryDate: true,
            store: { select: { name: true } },
            paymentSchedule: { select: { dueAt: true, status: true } },
          },
          orderBy: { deliveryDate: 'asc' },
        },
        payments: {
          where: { status: { in: ['PENDING', 'SUCCESS'] } },
          select: {
            id: true, amount: true, status: true, paymentMethod: true, bankTxNo: true,
            paidAt: true, createdAt: true,
            cashAccount: { select: { id: true, name: true, type: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { issueDate: 'asc' },
    })
    return invoices.map(invoice => {
      const pending = invoice.payments
        .filter(payment => payment.status === 'PENDING')
        .reduce((sum, payment) => sum.plus(payment.amount), new Prisma.Decimal(0))
      const remaining = invoice.amount.minus(invoice.paidAmount)
      const earliestDue = invoice.receipts.reduce<Date | null>((current, receipt) => {
        if (!receipt.paymentSchedule?.dueAt) return current
        const candidate = new Date(receipt.paymentSchedule.dueAt)
        return !current || candidate < current ? candidate : current
      }, null)
      return {
        ...invoice,
        fileUrl: resignOssUrl(invoice.fileUrl),
        remainingAmount: remaining.toNumber(),
        availableToInitiate: remaining.minus(pending).toNumber(),
        earliestDueAt: earliestDue?.toISOString() || null,
        paidPct: invoice.amount.greaterThan(0)
          ? invoice.paidAmount.div(invoice.amount).times(100).toDecimalPlaces(0).toNumber()
          : 0,
      }
    })
  })

  app.get('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) return reply.status(403).send({ error: '无权限' })
    if (isSupplierRole(role) && !supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
    const parsed = listSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const where: Prisma.InvoicePaymentWhereInput = { tenantId }
    if (parsed.data.invoiceId) where.invoiceId = parsed.data.invoiceId
    if (isSupplierRole(role)) where.invoice = { supplierId }
    return prisma.invoicePayment.findMany({
      where,
      include: {
        invoice: { select: { invoiceNo: true, amount: true, supplier: { select: { name: true } } } },
        cashAccount: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  app.post('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可发起付款' })
    const parsed = invoicePaymentCreateSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await createInvoicePayment({
        tenantId, userId, role,
        invoiceId: parsed.data.invoiceId,
        amount: new Prisma.Decimal(parsed.data.amount),
        paymentMethod: parsed.data.paymentMethod,
        requestId: parsed.data.requestId,
        note: parsed.data.note,
      })
      return reply.status(result.duplicated ? 200 : 201).send({
        ...result.payment, duplicated: result.duplicated,
      })
    } catch (error: any) {
      return sendError(req, reply, error, '发起付款失败')
    }
  })

  app.patch('/:id/confirm', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = invoicePaymentConfirmSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      if (parsed.data.status === 'FAILED') {
        const result = await failInvoicePayment({
          tenantId, userId, role, paymentId: req.params.id, failReason: parsed.data.failReason,
        })
        return { success: true, status: 'FAILED', duplicated: result.duplicated }
      }
      if (dayjs(parsed.data.paidAt).isAfter(dayjs(), 'day')) {
        return reply.status(400).send({ error: '付款日期不得晚于今天' })
      }
      const result = await confirmInvoicePaymentSuccess({
        tenantId, userId, role, paymentId: req.params.id,
        accountId: parsed.data.accountId,
        paidAt: parsed.data.paidAt,
        bankTxNo: parsed.data.bankTxNo,
        note: parsed.data.note,
      })
      return {
        success: true,
        status: 'SUCCESS',
        duplicated: result.duplicated,
        cashTransactionId: result.cashTransactionId,
        voucherId: result.voucherId,
        voucherWarning: result.voucherWarning,
      }
    } catch (error: any) {
      return sendError(req, reply, error, '付款确认失败')
    }
  })

  app.patch('/:id/cancel', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = cancelSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await cancelInvoicePayment({
        tenantId, userId, role, paymentId: req.params.id, reason: parsed.data.reason,
      })
      return { success: true, duplicated: result.duplicated }
    } catch (error: any) {
      return sendError(req, reply, error, '取消付款失败')
    }
  })
}
