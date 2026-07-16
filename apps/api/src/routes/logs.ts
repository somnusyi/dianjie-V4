import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { parsePagination } from '../lib/pagination'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 操作日志含跨模块敏感信息（改价、改人员、审批动作等），只允许总部级角色查看
const LOG_VIEW_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'FINANCE'])

export const logRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any, reply: any) => {
    if (!LOG_VIEW_ROLES.has(req.user.role)) {
      return reply.status(403).send({ error: '无权查看操作日志' })
    }
    const { page = 1, pageSize = 50 } = req.query as any
    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 100 })
    if (!pagination) return reply.status(400).send({ error: '分页参数格式不正确' })
    const [total, items] = await Promise.all([
      prisma.opLog.count({ where: { tenantId: req.user.tenantId } }),
      prisma.opLog.findMany({
        where: { tenantId: req.user.tenantId },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
    ])
    return { total, items, ...pagination }
  })
}
