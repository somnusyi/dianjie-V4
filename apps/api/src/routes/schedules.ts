import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { notifyApprovalDone } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const GROUP_READ_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN'])
const scheduleStatusSchema = z.enum([
  'PENDING', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'NOTIFIED',
  'PROCESSING', 'PAID', 'OVERDUE', 'CANCELLED', 'ON_HOLD',
])

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).optional(),
}).strict()

const legacyRejectSchema = z.object({
  note: z.string().trim().min(1, '驳回必须填写原因').max(1000),
}).strict()

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export const scheduleRoutes: FastifyPluginAsync = async (app) => {

  // 列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId, storeId } = req.user
    if (!GROUP_READ_ROLES.has(role) && !isSupplierRole(role) && !isStoreScoped(role)) {
      return reply.status(403).send({ error: '无权查看付款计划' })
    }
    const parsed = z.object({
      status: scheduleStatusSchema.optional(),
      days: z.string().regex(/^\d+$/).transform(Number).refine(value => value <= 365, 'days 最大为 365').optional(),
    }).strict().safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { status, days } = parsed.data
    const where: any = { tenantId }
    if (isSupplierRole(role)) where.supplierId = supplierId || '__NONE__'
    if (isStoreScoped(role)) where.storeId = storeId || '__NONE__'
    if (status) where.status = status
    if (days !== undefined) {
      const d = new Date()
      d.setDate(d.getDate() + days)
      where.dueAt = { lte: d }
    }
    return prisma.paymentSchedule.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true, creditType: true, creditDays: true } },
        receipt: {
          select: {
            id: true, no: true, deliveryDate: true, storeId: true,
            purchaseOrderId: true,  // supplier/billing 卡片点击跳 PO 详情用 (2026-06-02)
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

  async function reviewSchedule(params: {
    id: string
    tenantId: string
    userId: string
    role: string
    action: 'approve' | 'reject'
    note?: string
  }) {
    const { id, tenantId, userId, role, action, note } = params
    if (action === 'reject' && !note) throw httpError('驳回必须填写原因', 400)

    return prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-schedule-review:${id}`}))`
      const schedule = await tx.paymentSchedule.findFirst({
        where: { id, tenantId },
        include: { supplier: { select: { name: true } } },
      })
      if (!schedule) throw httpError('账期不存在', 404)

      const targetStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'
      if (schedule.status !== 'PENDING_APPROVAL') {
        let sameActor = schedule.approvedById === userId
        if (action === 'reject' && schedule.status === 'REJECTED' && schedule.rejectionNote === note) {
          const priorLog = await tx.opLog.findFirst({
            where: {
              tenantId, userId, entityType: 'PaymentSchedule', targetId: schedule.id,
              action: { startsWith: '拒绝账期付款' },
            },
            select: { id: true },
          })
          sameActor = Boolean(priorLog)
        }
        if (schedule.status === targetStatus && sameActor &&
            (action === 'approve' || schedule.rejectionNote === note)) {
          return {
            success: true, status: targetStatus, duplicated: true,
            amount: Number(schedule.amount), supplierName: schedule.supplier.name,
          }
        }
        throw httpError(`账期当前状态 ${schedule.status}，不可重复审批`, 409)
      }

      const now = new Date()
      await tx.paymentSchedule.update({
        where: { id: schedule.id },
        data: action === 'approve'
          ? {
              status: 'APPROVED', approvedById: userId, approvedAt: now,
              approvalNote: note || null, rejectedAt: null, rejectionNote: null,
            }
          : {
              status: 'REJECTED', rejectedAt: now, rejectionNote: note,
              approvedById: null, approvedAt: null, approvalNote: null,
            },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: action === 'approve'
            ? `审批通过账期付款 ¥${schedule.amount}`
            : `拒绝账期付款 ¥${schedule.amount}: ${note}`,
          entityType: 'PaymentSchedule', targetId: schedule.id,
          metadata: { action, note: note || null, previousStatus: schedule.status, targetStatus },
        },
      })
      return {
        success: true, status: targetStatus, duplicated: false,
        amount: Number(schedule.amount), supplierName: schedule.supplier.name,
      }
    })
  }

  // 审批（approve / reject，前端统一调此接口并传 action 字段）
  app.patch('/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const parsed = reviewSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      const result = await reviewSchedule({
        id: req.params.id, tenantId, userId, role, ...parsed.data,
      })
      if (parsed.data.action === 'approve' && !result.duplicated) {
        void notifyApprovalDone(tenantId, result.amount, result.supplierName, req.params.id).catch(error => {
          req.log.error({ err: error, scheduleId: req.params.id }, 'payment approval notification failed')
        })
      }
      return result
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'payment schedule review failed')
      return reply.status(500).send({ error: '账期审批失败，未保存任何变更' })
    }
  })

  // 兼容旧版单独的 reject 接口
  app.patch('/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const parsed = legacyRejectSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      return await reviewSchedule({
        id: req.params.id, tenantId, userId, role,
        action: 'reject', note: parsed.data.note,
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'payment schedule rejection failed')
      return reply.status(500).send({ error: '账期驳回失败，未保存任何变更' })
    }
  })
}
