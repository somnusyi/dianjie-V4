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
import { prisma } from '@dianjie/db'
import { isSupplierRole } from '../lib/auth-scope'

const FINANCE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])

export const invoicePaymentRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // ── 待付款发票列表 (财务用) ────────────────────
  app.get('/payable', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const where: any = {
      tenantId,
      status: 'VERIFIED',
      fullyPaidAt: null,
    }
    if (isSupplierRole(role) && supplierId) where.supplierId = supplierId

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
  app.get('/', auth, async (req: any) => {
    const { tenantId, role, supplierId } = req.user
    const { invoiceId } = req.query as any
    const where: any = { tenantId }
    if (invoiceId) where.invoiceId = invoiceId
    // 供应商只看自己发票的付款
    if (isSupplierRole(role) && supplierId) {
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

    const { invoiceId, amount, paymentMethod = 'cmb', note } = req.body as any
    if (!invoiceId) return reply.status(400).send({ error: '缺 invoiceId' })
    const amt = Number(amount)
    if (!amt || amt <= 0) return reply.status(400).send({ error: '付款金额必须 > 0' })

    const inv = await prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId, status: 'VERIFIED' },
      include: {
        payments: { where: { status: { in: ['PENDING', 'SUCCESS'] } } },
      },
    })
    if (!inv) return reply.status(404).send({ error: '发票不存在或未审核通过' })
    if (inv.fullyPaidAt) return reply.status(400).send({ error: '该发票已付清' })

    // 计算实际剩余 (paidAmount 是 SUCCESS 累计, PENDING 也要扣留, 防超付)
    const reservedSuccessOrPending = inv.payments.reduce((s, p) => s + Number(p.amount), 0)
    const realRemaining = Number(inv.amount) - reservedSuccessOrPending
    if (amt > realRemaining + 0.01) {
      return reply.status(400).send({
        error: `本次付款 ¥${amt.toLocaleString()} 超过剩余可付 ¥${realRemaining.toLocaleString()}`,
      })
    }

    const payment = await prisma.invoicePayment.create({
      data: {
        tenantId, invoiceId,
        amount: amt, paymentMethod,
        status: 'PENDING',
        initiatedById: userId,
        note: note || null,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: `发起发票付款 #${inv.invoiceNo} ¥${amt.toLocaleString()} (剩余 ¥${(realRemaining - amt).toLocaleString()})`,
        entityType: 'InvoicePayment', targetId: payment.id,
      },
    })
    // TODO Sprint B: 触发 cmb 转账, 完成后回调 /:id/confirm
    return reply.status(201).send(payment)
  })

  // ── 确认付款结果 (银行回调/手工) ─────────────
  app.patch('/:id/confirm', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const { status, bankTxNo, failReason } = req.body as any
    if (!['SUCCESS', 'FAILED'].includes(status)) {
      return reply.status(400).send({ error: 'status 必须是 SUCCESS 或 FAILED' })
    }
    const p = await prisma.invoicePayment.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING' },
    })
    if (!p) return reply.status(404).send({ error: '付款单不存在或非 PENDING' })

    if (status === 'SUCCESS') {
      // 事务: 更新 payment + 累加 invoice.paidAmount + 检查是否付清
      await prisma.$transaction(async (tx) => {
        await tx.invoicePayment.update({
          where: { id: p.id },
          data: { status: 'SUCCESS', paidAt: new Date(), bankTxNo: bankTxNo || null },
        })
        const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId } })
        if (!inv) throw new Error('invoice missing')
        const newPaid = Number(inv.paidAmount) + Number(p.amount)
        const fullyPaid = Math.abs(newPaid - Number(inv.amount)) < 0.01
        await tx.invoice.update({
          where: { id: p.invoiceId },
          data: {
            paidAmount: newPaid,
            fullyPaidAt: fullyPaid ? new Date() : null,
          },
        })
      })
      await prisma.opLog.create({
        data: { tenantId, userId,
          action: `付款到账 ¥${p.amount}` + (bankTxNo ? ` 流水 ${bankTxNo}` : ''),
          entityType: 'InvoicePayment', targetId: p.id,
        },
      })
    } else {
      // FAILED
      await prisma.invoicePayment.update({
        where: { id: p.id },
        data: { status: 'FAILED', failReason: failReason || '银行返回失败' },
      })
      await prisma.opLog.create({
        data: { tenantId, userId, action: `付款失败 ¥${p.amount} ${failReason || ''}`,
          entityType: 'InvoicePayment', targetId: p.id },
      })
    }
    return { success: true, status }
  })

  // ── 取消(仅 PENDING) ─────────────────────────
  app.patch('/:id/cancel', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const p = await prisma.invoicePayment.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING' },
    })
    if (!p) return reply.status(404).send({ error: '付款单不存在或不可取消' })
    await prisma.invoicePayment.update({
      where: { id: p.id },
      data: { status: 'CANCELED' },
    })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `取消付款 ¥${p.amount}`,
        entityType: 'InvoicePayment', targetId: p.id },
    })
    return { success: true }
  })
}
