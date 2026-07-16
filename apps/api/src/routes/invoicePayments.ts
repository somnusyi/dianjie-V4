/**
 * 发票付款 (财务分次部分付款)
 *
 *   GET    /api/invoice-payments/payable    待付款发票列表 (status=VERIFIED 且未付清)
 *   GET    /api/invoice-payments?invoiceId  某发票的付款历史
 *   POST   /api/invoice-payments            财务发起一笔部分付款
 *                                           body: { invoiceId, amount, paymentMethod, note }
 *                                           校验: amount ≤ invoice.remainingAmount
 *                                           创建 PENDING → 调用 cmb 微服务异步转账
 *   PATCH  /api/invoice-payments/:id/confirm  银行回调或手动确认
 *                                           body: { status: SUCCESS | FAILED, bankTxNo?, failReason? }
 *   PATCH  /api/invoice-payments/:id/cancel  财务取消(仅 PENDING 状态可)
 */
import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { writeCashTransaction } from '../services/cashbook'
import { voucherForPayment } from '../services/voucher'
import { lockSchedulesForInvoicePayment } from '../services/paymentMutex'

const FINANCE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])
const paymentCreateSchema = z.object({
  invoiceId: z.string().trim().min(1),
  amount: z.number().positive('付款金额必须 > 0').max(999_999_999_999.99).refine(
    value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
    '付款金额最多保留 2 位小数',
  ),
  paymentMethod: z.enum(['cmb', 'manual', 'wechat', 'alipay']).default('cmb'),
  note: z.string().trim().max(500).optional(),
}).strict()

const paymentConfirmSchema = z.object({
  status: z.enum(['SUCCESS', 'FAILED']),
  bankTxNo: z.string().trim().max(100).optional(),
  failReason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'FAILED' && !value.failReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failReason'], message: '付款失败必须填写原因' })
  }
})

type InvoicePaymentVoucherInput = {
  paymentId: string
  invoiceNo: string
  supplierName: string
  amount: number
  paymentMethod: string
  paidAt: Date
}

export const invoicePaymentRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // ── 待付款发票列表 (财务用) ────────────────────
  app.get('/payable', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '账号未绑定供应商' })
    }
    const where: any = {
      tenantId,
      status: 'VERIFIED',
      fullyPaidAt: null,
    }
    if (isSupplierRole(role)) where.supplierId = supplierId

    const list = await prisma.invoice.findMany({
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
          select: { id: true, amount: true, status: true, paidAt: true, createdAt: true },
        },
      },
      orderBy: [{ issueDate: 'asc' }],
    })
    // 派生 remainingAmount + 最早 receipt 的应付到期日
    return list.map(i => {
      const remaining = Number(i.amount) - Number(i.paidAmount)
      const earliestDue = i.receipts.reduce<Date | null>((d, r) => {
        const due = r.paymentSchedule?.dueAt
        if (!due) return d
        const x = new Date(due)
        return d == null || x < d ? x : d
      }, null)
      return {
        ...i,
        remainingAmount: remaining,
        earliestDueAt: earliestDue?.toISOString() || null,
        // 进度
        paidPct: Number(i.amount) > 0 ? Math.round(Number(i.paidAmount) / Number(i.amount) * 100) : 0,
      }
    })
  })

  // ── 某发票的付款历史 ──────────────────────────
  app.get('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '账号未绑定供应商' })
    }
    const { invoiceId } = req.query as any
    const where: any = { tenantId }
    if (invoiceId) where.invoiceId = invoiceId
    // 供应商只看自己发票的付款
    if (isSupplierRole(role)) {
      where.invoice = { supplierId }
    }
    return prisma.invoicePayment.findMany({
      where,
      include: {
        invoice: { select: { invoiceNo: true, amount: true, supplier: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  // ── 发起付款 ──────────────────────────────────
  app.post('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可发起付款' })

    const parsed = paymentCreateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { invoiceId, amount, paymentMethod, note } = parsed.data
    const amt = new Prisma.Decimal(amount)

    // 防重付互斥 + 创建付款 用同一事务, 互斥失败整体回滚
    let payment: any
    try {
      payment = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "invoices"
          WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `)
        if (locked.length !== 1) throw Object.assign(new Error('发票不存在'), { statusCode: 404 })
        const inv = await tx.invoice.findFirst({
          where: { id: invoiceId, tenantId, status: 'VERIFIED' },
          include: { payments: { where: { status: { in: ['PENDING', 'SUCCESS'] } } } },
        })
        if (!inv) throw Object.assign(new Error('发票不存在或未审核通过'), { statusCode: 404 })
        if (inv.fullyPaidAt) throw Object.assign(new Error('该发票已付清'), { statusCode: 409 })
        const reserved = inv.payments.reduce(
          (sum, existing) => sum.plus(existing.amount),
          new Prisma.Decimal(0),
        )
        const realRemaining = inv.amount.minus(reserved)
        if (amt.greaterThan(realRemaining)) {
          throw Object.assign(
            new Error(`本次付款 ¥${amt.toFixed(2)} 超过剩余可付 ¥${realRemaining.toFixed(2)}`),
            { statusCode: 409 },
          )
        }

        // 1. 锁定关联账期 (防重付; PAID/PROCESSING 直接抛错回滚)
        const { cancelledCount } = await lockSchedulesForInvoicePayment(tx, invoiceId, userId)
        // 2. 创建付款单
        const p = await tx.invoicePayment.create({
          data: {
            tenantId, invoiceId,
            amount: amt, paymentMethod,
            status: 'PENDING',
            initiatedById: userId,
            note: note || null,
          },
        })
        await tx.opLog.create({
          data: { tenantId, userId,
            action: `发起发票付款 #${inv.invoiceNo} ¥${amt.toFixed(2)} (剩余 ¥${realRemaining.minus(amt).toFixed(2)})`
              + (cancelledCount > 0 ? ` · 同步锁定 ${cancelledCount} 条关联账期` : ''),
            entityType: 'InvoicePayment', targetId: p.id,
          },
        })
        return p
      })
    } catch (e: any) {
      return reply.status(e?.statusCode || 409).send({ error: e.message || '互斥失败' })
    }
    // TODO Sprint B: 触发 cmb 转账, 完成后回调 /:id/confirm
    return reply.status(201).send(payment)
  })

  // ── 确认付款结果 (银行回调/手工) ─────────────
  app.patch('/:id/confirm', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = paymentConfirmSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { status, bankTxNo, failReason } = parsed.data

    let voucherInput: InvoicePaymentVoucherInput | null = null
    let duplicated = false
    if (status === 'SUCCESS') {
      try {
        await prisma.$transaction(async (tx) => {
          const lockedPayments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "invoice_payments"
            WHERE "id" = ${req.params.id} AND "tenantId" = ${tenantId}
            FOR UPDATE
          `)
          if (lockedPayments.length !== 1) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
          const p = await tx.invoicePayment.findFirst({ where: { id: req.params.id, tenantId } })
          if (!p) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
          if (p.status === 'SUCCESS') {
            duplicated = true
            return
          }
          if (p.status !== 'PENDING') {
            throw Object.assign(new Error(`付款单当前状态 ${p.status}，不能确认成功`), { statusCode: 409 })
          }
          const lockedInvoices = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "invoices"
            WHERE "id" = ${p.invoiceId} AND "tenantId" = ${tenantId}
            FOR UPDATE
          `)
          if (lockedInvoices.length !== 1) throw Object.assign(new Error('发票不存在'), { statusCode: 404 })
          const inv = await tx.invoice.findUnique({
            where: { id: p.invoiceId },
            include: { supplier: { select: { name: true } } },
          })
          if (!inv) throw Object.assign(new Error('发票不存在'), { statusCode: 404 })
          const newPaid = inv.paidAmount.plus(p.amount)
          if (newPaid.greaterThan(inv.amount)) {
            throw Object.assign(new Error('付款累计超过发票金额，已阻断到账确认'), { statusCode: 409 })
          }
          const paidAt = new Date()
          await tx.invoicePayment.update({
            where: { id: p.id },
            data: { status: 'SUCCESS', paidAt, bankTxNo: bankTxNo || null },
          })
          await tx.invoice.update({
            where: { id: p.invoiceId },
            data: { paidAmount: newPaid, fullyPaidAt: newPaid.equals(inv.amount) ? paidAt : null },
          })
          await writeCashTransaction(tx, {
            tenantId,
            direction: -1,
            category: '发票付款',
            amount: Number(p.amount),
            note: `${inv.supplier.name} 发票 ${inv.invoiceNo}` + (bankTxNo ? ` 流水 ${bankTxNo}` : ''),
            txDate: paidAt,
            refType: 'InvoicePayment',
            refId: p.id,
            createdById: userId,
          })
          await tx.opLog.create({
            data: {
              tenantId, userId,
              action: `付款到账 ¥${p.amount}` + (bankTxNo ? ` 流水 ${bankTxNo}` : ''),
              entityType: 'InvoicePayment', targetId: p.id,
            },
          })
          voucherInput = {
            paymentId: p.id,
            invoiceNo: inv.invoiceNo,
            supplierName: inv.supplier.name,
            amount: Number(p.amount),
            paymentMethod: p.paymentMethod,
            paidAt,
          }
        })
      } catch (error: any) {
        return reply.status(error?.statusCode || 500).send({ error: error.message || '付款确认失败' })
      }
      // 生凭证 (借 应付账款 / 贷 银行存款)
      const voucher = voucherInput as unknown as InvoicePaymentVoucherInput | null
      if (voucher) voucherForPayment({
        tenantId,
        paymentId: voucher.paymentId,
        paymentNo: voucher.invoiceNo,
        supplierName: voucher.supplierName,
        amount: voucher.amount,
        method: voucher.paymentMethod === 'cmb' ? 'CMB_AUTOPAY' : voucher.paymentMethod === 'manual' ? 'OFFLINE' : 'BANK_TRANSFER',
        date: voucher.paidAt,
      })
    } else {
      try {
        await prisma.$transaction(async tx => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "invoice_payments"
            WHERE "id" = ${req.params.id} AND "tenantId" = ${tenantId}
            FOR UPDATE
          `)
          if (locked.length !== 1) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
          const p = await tx.invoicePayment.findFirst({ where: { id: req.params.id, tenantId } })
          if (!p) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
          if (p.status === 'FAILED') {
            duplicated = true
            return
          }
          if (p.status !== 'PENDING') {
            throw Object.assign(new Error(`付款单当前状态 ${p.status}，不能确认失败`), { statusCode: 409 })
          }
          await tx.invoicePayment.update({
            where: { id: p.id },
            data: { status: 'FAILED', failReason },
          })
          await tx.opLog.create({
            data: { tenantId, userId, action: `付款失败 ¥${p.amount} ${failReason}`,
              entityType: 'InvoicePayment', targetId: p.id },
          })
        })
      } catch (error: any) {
        return reply.status(error?.statusCode || 500).send({ error: error.message || '付款确认失败' })
      }
    }
    return { success: true, status, duplicated }
  })

  // ── 取消(仅 PENDING) ─────────────────────────
  app.patch('/:id/cancel', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    try {
      let duplicated = false
      await prisma.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "invoice_payments"
          WHERE "id" = ${req.params.id} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `)
        if (locked.length !== 1) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
        const p = await tx.invoicePayment.findFirst({ where: { id: req.params.id, tenantId } })
        if (!p) throw Object.assign(new Error('付款单不存在'), { statusCode: 404 })
        if (p.status === 'CANCELED') {
          duplicated = true
          return
        }
        if (p.status !== 'PENDING') {
          throw Object.assign(new Error(`付款单当前状态 ${p.status}，不可取消`), { statusCode: 409 })
        }
        await tx.invoicePayment.update({ where: { id: p.id }, data: { status: 'CANCELED' } })
        await tx.opLog.create({
          data: { tenantId, userId, action: `取消付款 ¥${p.amount}`,
            entityType: 'InvoicePayment', targetId: p.id },
        })
      })
      return { success: true, duplicated }
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error.message || '取消付款失败' })
    }
  })
}
