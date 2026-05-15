import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { generateNo } from '../utils/no'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { page = '1', pageSize = '20' } = req.query as any
    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    // 供应商只能看自己的付款单
    const where: any = { tenantId: req.user.tenantId }
    if (isSupplierRole(req.user.role)) where.supplierId = req.user.supplierId || '__NONE__'
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          supplier: { select: { name: true, bankAccount: true } },
          reconciliation: { select: { no: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.payment.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权限' })

    const { reconciliationId, amount, method, note } = req.body
    const recon = await prisma.reconciliation.findFirst({ where: { id: reconciliationId, tenantId } })
    if (!recon) return reply.status(404).send({ error: '对账单不存在' })
    if (recon.status !== 'APPROVED') return reply.status(400).send({ error: '对账单未审核通过' })

    // P1: 校验金额. amount 必须 > 0 且 = 对账单总额 (单次全额付; 部分付款功能未上线)
    const amt = Number(amount)
    if (!Number.isFinite(amt) || amt <= 0) return reply.status(400).send({ error: '金额无效' })
    if (Math.abs(amt - Number(recon.totalAmount)) > 0.01) {
      return reply.status(400).send({ error: `金额与对账单不符 (¥${recon.totalAmount})` })
    }
    const ALLOWED_METHOD = ['BANK_TRANSFER', 'CMB_AUTOPAY', 'OFFLINE', 'CASH']
    const finalMethod = ALLOWED_METHOD.includes(method) ? method : 'BANK_TRANSFER'

    const no = await generateNo('PY', tenantId)
    const payment = await prisma.payment.create({
      data: { tenantId, no, supplierId: recon.supplierId, reconciliationId, amount: amt, method: finalMethod, status: 'UNPAID', note },
    })

    await prisma.reconciliation.update({ where: { id: recon.id }, data: { status: 'PAYMENT_GENERATED' } })
    await prisma.opLog.create({ data: { tenantId, userId, role, action: '创建付款单', target: no } })
    return reply.status(201).send(payment)
  })

  app.patch('/:id/paid', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权限' })

    const { bankTxNo } = req.body
    const where: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) where.supplierId = req.user.supplierId || '__NONE__'
    const payment = await prisma.payment.findFirst({ where })
    if (!payment) return reply.status(404).send({ error: '付款单不存在' })

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'PAID', paidAt: new Date(), bankTxNo },
    })
    if (payment.reconciliationId) {
      await prisma.reconciliation.update({
        where: { id: payment.reconciliationId },
        data: { status: 'DONE' },
      })
    }
    await prisma.opLog.create({ data: { tenantId, userId, role, action: '标记付款完成', target: payment.no } })
    return { message: '付款完成' }
  })
}
