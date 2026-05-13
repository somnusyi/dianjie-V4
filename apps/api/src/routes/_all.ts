import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { generateNo } from '../utils/no'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// ══════════════════════════════════════════════════════
// SUPPLIERS
// ══════════════════════════════════════════════════════
export const supplierRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    return prisma.supplier.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: 'asc' },
    })
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) return reply.status(403).send({ error: '无权限' })
    const supplier = await prisma.supplier.create({ data: { tenantId, ...req.body } })
    return reply.status(201).send(supplier)
  })

  app.patch('/:id', auth(app), async (req: any) => {
    return prisma.supplier.updateMany({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      data: req.body,
    })
  })

  app.patch('/:id/toggle', auth(app), async (req: any) => {
    const s = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
    if (!s) return { error: '供应商不存在' }
    return prisma.supplier.update({
      where: { id: s.id },
      data: { status: s.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
    })
  })
}

// ══════════════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════════════
export const productRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { category, status } = req.query as any
    const where: any = { tenantId: req.user.tenantId }
    if (category) where.category = category
    if (status) where.status = status
    return prisma.product.findMany({
      where,
      include: { supplier: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const product = await prisma.product.create({ data: { tenantId: req.user.tenantId, ...req.body } })
    return reply.status(201).send(product)
  })

  app.patch('/:id', auth(app), async (req: any) => {
    return prisma.product.updateMany({
      where: { id: req.params.id, tenantId: req.user.tenantId },
      data: req.body,
    })
  })
}

// ══════════════════════════════════════════════════════
// RECONCILIATIONS
// ══════════════════════════════════════════════════════
export const reconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    return prisma.reconciliation.findMany({
      where: { tenantId: req.user.tenantId },
      include: {
        supplier: { select: { name: true, no: true } },
        items: { include: { receipt: { select: { no: true, totalAmount: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // 生成对账单
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) return reply.status(403).send({ error: '无权限' })

    const { supplierId, periodStart, periodEnd } = req.body

    // 找该供应商期间内已确认未对账的入库单
    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId,
        supplierId,
        status: 'CONFIRMED',
        deliveryDate: { gte: new Date(periodStart), lte: new Date(periodEnd) },
      },
    })
    if (!receipts.length) return reply.status(400).send({ error: '该供应商在此期间无可对账的入库单' })

    const totalAmount = receipts.reduce((s, r) => s + Number(r.totalAmount), 0)
    const no = await generateNo('DC', tenantId)

    const recon = await prisma.reconciliation.create({
      data: {
        tenantId,
        no,
        supplierId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        totalAmount,
        status: 'DRAFT',
        items: { create: receipts.map(r => ({ receiptId: r.id, amount: r.totalAmount })) },
      },
    })

    // 更新入库单状态为已对账
    await prisma.receipt.updateMany({
      where: { id: { in: receipts.map(r => r.id) } },
      data: { status: 'ACCOUNTED' },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, role, action: '生成对账单', target: no, entityType: 'Reconciliation', targetId: recon.id },
    })

    return reply.status(201).send(recon)
  })

  // 审核通过/驳回
  app.patch('/:id/review', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) return reply.status(403).send({ error: '无权限' })
    const { action, note } = req.body // action: 'approve' | 'reject'

    const recon = await prisma.reconciliation.findFirst({ where: { id: req.params.id, tenantId } })
    if (!recon) return reply.status(404).send({ error: '对账单不存在' })
    if (recon.status !== 'DRAFT') return reply.status(400).send({ error: '只有草稿状态可审核' })

    const status = action === 'approve' ? 'APPROVED' : 'REJECTED'
    await prisma.reconciliation.update({
      where: { id: recon.id },
      data: { status, reviewedAt: new Date(), reviewNote: note },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, role, action: action === 'approve' ? '审核通过对账单' : '驳回对账单', target: recon.no },
    })
    return { message: action === 'approve' ? '审核通过' : '已驳回' }
  })
}

// ══════════════════════════════════════════════════════
// PAYMENTS
// ══════════════════════════════════════════════════════
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    return prisma.payment.findMany({
      where: { tenantId: req.user.tenantId },
      include: {
        supplier: { select: { name: true, bankAccount: true } },
        reconciliation: { select: { no: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // 创建付款单
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) return reply.status(403).send({ error: '无权限' })

    const { reconciliationId, amount, method, note } = req.body
    const recon = await prisma.reconciliation.findFirst({ where: { id: reconciliationId, tenantId } })
    if (!recon) return reply.status(404).send({ error: '对账单不存在' })
    if (recon.status !== 'APPROVED') return reply.status(400).send({ error: '对账单未审核通过' })

    const no = await generateNo('PY', tenantId)
    const payment = await prisma.payment.create({
      data: { tenantId, no, supplierId: recon.supplierId, reconciliationId, amount, method, status: 'UNPAID', note },
    })

    await prisma.reconciliation.update({ where: { id: recon.id }, data: { status: 'PAYMENT_GENERATED' } })
    await prisma.opLog.create({ data: { tenantId, userId, role, action: '创建付款单', target: no } })

    return reply.status(201).send(payment)
  })

  // 标记已支付
  app.patch('/:id/paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) return reply.status(403).send({ error: '无权限' })

    const { bankTxNo } = req.body
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, tenantId },
      include: { reconciliation: true },
    })
    if (!payment) return reply.status(404).send({ error: '付款单不存在' })

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'PAID', paidAt: new Date(), bankTxNo },
    })
    if (payment.reconciliation) {
      await prisma.reconciliation.update({ where: { id: payment.reconciliationId! }, data: { status: 'DONE' } })
    }

    await prisma.opLog.create({ data: { tenantId, userId, role, action: '标记付款完成', target: payment.no } })
    return { message: '付款完成' }
  })
}

// ══════════════════════════════════════════════════════
// PAYMENT SCHEDULES
// ══════════════════════════════════════════════════════
export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { status, days } = req.query as any
    const where: any = { tenantId: req.user.tenantId }
    if (status) where.status = status
    if (days) {
      const d = new Date()
      d.setDate(d.getDate() + Number(days))
      where.dueAt = { lte: d }
    }
    return prisma.paymentSchedule.findMany({
      where,
      include: {
        supplier: { select: { name: true, creditType: true, creditDays: true } },
        receipt: { select: { no: true, deliveryDate: true } },
      },
      orderBy: { dueAt: 'asc' },
    })
  })
}

// ══════════════════════════════════════════════════════
// OP LOGS
// ══════════════════════════════════════════════════════
export const logRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { page = 1, pageSize = 50 } = req.query as any
    const [total, items] = await Promise.all([
      prisma.opLog.count({ where: { tenantId: req.user.tenantId } }),
      prisma.opLog.findMany({
        where: { tenantId: req.user.tenantId },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: Number(pageSize),
      }),
    ])
    return { total, items }
  })
}
