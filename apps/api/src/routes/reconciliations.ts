import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { generateNo } from '../utils/no'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const reconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const where: any = { tenantId: req.user.tenantId }
    if (isSupplierRole(req.user.role)) where.supplierId = req.user.supplierId || '__NONE__'
    return prisma.reconciliation.findMany({
      where,
      include: {
        supplier: { select: { name: true, no: true } },
        items: { include: { receipt: { select: { no: true, totalAmount: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权限' })

    const { supplierId, periodStart, periodEnd } = req.body
    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId,
        supplierId,
        status: 'CONFIRMED',
        deliveryDate: { gte: new Date(periodStart), lte: new Date(periodEnd) },
      },
    })
    if (!receipts.length)
      return reply.status(400).send({ error: '该供应商在此期间无可对账的入库单' })

    const totalAmount = receipts.reduce((s, r) => s + Number(r.totalAmount), 0)
    const no = await generateNo('DC', tenantId)

    const recon = await prisma.reconciliation.create({
      data: {
        tenantId, no, supplierId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        totalAmount, status: 'DRAFT',
        items: { create: receipts.map(r => ({ receiptId: r.id, amount: r.totalAmount })) },
      },
      include: {
        supplier: { select: { name: true, no: true } },
        items: { include: { receipt: { select: { no: true, totalAmount: true } } } },
      },
    })

    await prisma.receipt.updateMany({
      where: { id: { in: receipts.map(r => r.id) } },
      data: { status: 'ACCOUNTED' },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, role, action: '生成对账单', target: no, entityType: 'Reconciliation', targetId: recon.id },
    })

    return reply.status(201).send(recon)
  })

  app.patch('/:id/review', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权限' })

    const { action, note } = req.body
    const reconWhere: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) reconWhere.supplierId = req.user.supplierId || '__NONE__'
    const recon = await prisma.reconciliation.findFirst({ where: reconWhere })
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
