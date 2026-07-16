import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const notificationRoutes: FastifyPluginAsync = async (app) => {

  // ── 通知列表（当前用户，分页）──────────────────────
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { page = '1', pageSize = '20', unreadOnly } = req.query as any

    const where: any = {
      tenantId,
      OR: [
        { recipientId: userId },
        { recipientId: null, recipientRole: role },
      ],
    }
    if (unreadOnly === 'true') where.read = false

    const p = Math.max(1, parseInt(page))
    const ps = Math.min(50, Math.max(1, parseInt(pageSize)))

    const [items, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.notification.count({ where }),
    ])

    return { items, total, page: p, pageSize: ps }
  })

  // ── 未读数量（轻量接口，给角标用）──────────────────
  app.get('/unread-count', auth(app), async (req: any) => {
    const { tenantId, userId, role } = req.user
    const count = await prisma.notification.count({
      where: {
        tenantId,
        read: false,
        OR: [
          { recipientId: userId },
          { recipientId: null, recipientRole: role },
        ],
      },
    })
    return { count }
  })

  // ── 标记单条已读 ──────────────────────────────────
  app.patch('/:id/read', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const parsed = z.object({ id: z.string().trim().min(1).max(64) }).strict().safeParse(req.params || {})
    if (!parsed.success) return reply.status(400).send({ error: '通知标识格式不正确' })
    const result = await prisma.notification.updateMany({
      where: {
        id: parsed.data.id,
        tenantId,
        OR: [
          { recipientId: userId },
          { recipientId: null, recipientRole: role },
        ],
      },
      data: { read: true },
    })
    if (result.count === 0) return reply.status(404).send({ error: '通知不存在或无权访问' })
    return { success: true }
  })

  // ── 全部标记已读 ──────────────────────────────────
  app.patch('/read-all', auth(app), async (req: any) => {
    const { tenantId, userId, role } = req.user
    await prisma.notification.updateMany({
      where: {
        tenantId,
        read: false,
        OR: [
          { recipientId: userId },
          { recipientId: null, recipientRole: role },
        ],
      },
      data: { read: true },
    })
    return { success: true }
  })
}
