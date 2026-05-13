import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { cached, invalidatePattern } from '../lib/cache'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// Round 7 QA：原 POST 用 `data: { tenantId, ...req.body }` 会被 body 里的 tenantId
// 覆盖（tenant 隔离风险）+ 缺输入校验（和 products 同类风险）。加 strict zod。
const supplierCreateSchema = z.object({
  no:            z.string().trim().min(1).max(40),
  name:          z.string().trim().min(1).max(80),
  contactName:   z.string().trim().max(40).optional().default(''),
  contactPhone:  z.string().trim().max(20).optional().default(''),
  category:      z.string().trim().max(40).optional().default(''),
  creditType:    z.enum(['FIXED_DAYS', 'MONTHLY', 'IMMEDIATE']).optional().default('FIXED_DAYS'),
  creditDays:    z.number().int().min(0).max(365).optional().default(30),
  autoPay:       z.boolean().optional().default(false),
  bankName:      z.string().trim().max(80).optional().default(''),
  bankAccount:   z.string().trim().max(40).optional().default(''),
  bankAccountName: z.string().trim().max(80).optional().default(''),
}).strict()

export const supplierRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any) => {
    const { status, page, pageSize = '20' } = req.query as any
    const where: any = { tenantId: req.user.tenantId }
    if (status) where.status = status

    // 不传 page 时返回全量（兼容下拉框），缓存 10 分钟
    if (!page) {
      return cached(`suppliers:full:${req.user.tenantId}:${status || 'all'}`, 600, () =>
        prisma.supplier.findMany({ where, orderBy: { createdAt: 'asc' } })
      )
    }
    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (p - 1) * ps, take: ps }),
      prisma.supplier.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权限' })
    const parsed = supplierCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    try {
      const supplier = await prisma.supplier.create({ data: { tenantId, ...parsed.data } as any })
      void invalidatePattern(`suppliers:full:${tenantId}:*`)
      return reply.status(201).send(supplier)
    } catch (e: any) {
      if (e.code === 'P2002') return reply.status(409).send({ error: '供应商编号已存在' })
      req.log.error({ err: e }, 'supplier create failed')
      return reply.status(500).send({ error: '创建失败（请检查日志）' })
    }
  })

  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const existing = await prisma.supplier.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
    })
    if (!existing) return reply.status(404).send({ error: '供应商不存在' })
    const result = await prisma.supplier.update({
      where: { id: req.params.id },
      data: req.body,
    })
    void invalidatePattern(`suppliers:full:${req.user.tenantId}:*`)
    return result
  })

  app.patch('/:id/toggle', auth(app), async (req: any, reply: any) => {
    const s = await prisma.supplier.findFirst({
      where: { id: req.params.id, tenantId: req.user.tenantId },
    })
    if (!s) return reply.status(404).send({ error: '供应商不存在' })
    const updated = await prisma.supplier.update({
      where: { id: s.id },
      data: { status: s.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
    })
    void invalidatePattern(`suppliers:full:${req.user.tenantId}:*`)
    return updated
  })
}
