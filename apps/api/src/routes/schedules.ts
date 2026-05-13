import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { notifyApprovalDone } from '../services/notification'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const scheduleRoutes: FastifyPluginAsync = async (app) => {

  // 列表
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, role, supplierId } = req.user
    const { status, days } = req.query as any
    const where: any = { tenantId }
    if (isSupplierRole(role)) where.supplierId = supplierId || '__NONE__'
    if (status) where.status = status
    if (days) {
      const d = new Date()
      d.setDate(d.getDate() + Number(days))
      where.dueAt = { lte: d }
    }
    return prisma.paymentSchedule.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true, creditType: true, creditDays: true } },
        receipt: {
          select: {
            id: true, no: true, deliveryDate: true, storeId: true,
            store: { select: { name: true } },
            invoice: { select: { id: true, invoiceNo: true, status: true } },
          },
        },
      },
      orderBy: { dueAt: 'asc' },
    })
  })

  // 待审批列表（>2000需审批的）
  app.get('/pending-approval', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限查看待审批列表' })
    }
    return prisma.paymentSchedule.findMany({
      where: { tenantId, status: 'PENDING_APPROVAL' },
      include: {
        supplier: { select: { id: true, name: true } },
        receipt: { select: { id: true, no: true, store: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  // 审批（approve / reject，前端统一调此接口并传 action 字段）
  app.patch('/:id/approve', auth(app), async (req: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '无权限' }
    }
    const { action = 'approve', note } = req.body as any
    const schedule = await prisma.paymentSchedule.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING_APPROVAL' },
    })
    if (!schedule) throw { statusCode: 404, message: '账期不存在或状态不对' }

    if (action === 'approve') {
      await prisma.paymentSchedule.update({
        where: { id: schedule.id },
        data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date(), approvalNote: note },
      })
    } else {
      await prisma.paymentSchedule.update({
        where: { id: schedule.id },
        data: { status: 'REJECTED', rejectedAt: new Date(), rejectionNote: note },
      })
    }

    await prisma.opLog.create({
      data: {
        tenantId, userId, role,
        action: action === 'approve' ? `审批通过账期付款 ¥${schedule.amount}` : `拒绝账期付款 ¥${schedule.amount}`,
        entityType: 'PaymentSchedule', targetId: schedule.id,
      },
    })

    if (action === 'approve') {
      const supplier = await prisma.supplier.findUnique({ where: { id: schedule.supplierId }, select: { name: true } })
      void notifyApprovalDone(tenantId, Number(schedule.amount), supplier?.name || '')
    }
    return { success: true }
  })

  // 兼容旧版单独的 reject 接口
  app.patch('/:id/reject', auth(app), async (req: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '无权限' }
    }
    const { note } = req.body as any
    const schedule = await prisma.paymentSchedule.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING_APPROVAL' },
    })
    if (!schedule) throw { statusCode: 404, message: '账期不存在' }
    await prisma.paymentSchedule.update({
      where: { id: schedule.id },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectionNote: note },
    })
    return { success: true }
  })
}
