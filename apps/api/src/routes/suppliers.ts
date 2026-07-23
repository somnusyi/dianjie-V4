import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { cached, invalidatePattern } from '../lib/cache'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const entityIdSchema = z.string().trim().min(1).max(64)
const listQuerySchema = z.object({
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
}).strict()
const FINANCE_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN'])
const SUPPLIER_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF'])
const SAFE_SELECT = {
  id: true, no: true, name: true, category: true, status: true,
} as const

// Round 7 QA：原 POST 用 `data: { tenantId, ...req.body }` 会被 body 里的 tenantId
// 覆盖（tenant 隔离风险）+ 缺输入校验（和 products 同类风险）。加 strict zod。
const supplierCreateSchema = z.object({
  no:            z.string().trim().min(1).max(40),
  name:          z.string().trim().min(1).max(80),
  contactName:   z.string().trim().max(40).optional().default(''),
  contactPhone:  z.string().trim().max(20).optional().default(''),
  category:      z.string().trim().max(40).optional().default(''),
  creditType:    z.enum(['FIXED_DAYS', 'MONTHLY', 'WEEKLY', 'ON_DELIVERY']).optional().default('FIXED_DAYS'),
  creditDays:    z.number().int().min(0).max(365).optional().default(30),
  autoPay:       z.boolean().optional().default(false),
  autoPayLimit:  z.union([z.number().finite().min(0).max(1_000_000_000), z.null()]).optional(),
  bankName:      z.string().trim().max(80).optional().default(''),
  bankAccount:   z.string().trim().max(40).optional().default(''),
  bankAccountName: z.string().trim().max(80).optional().default(''),
  bankCode:      z.string().trim().max(40).optional().default(''),
}).strict()

// PATCH 可改字段(白名单): 排除 tenantId/status/id 等敏感/系统字段
const supplierUpdateSchema = supplierCreateSchema.partial()

export const supplierRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', auth(app), async (req: any, reply: any) => {
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { role, supplierId } = req.user
    const { status, page, pageSize: requestedPageSize } = parsed.data
    const paginated = page !== undefined || requestedPageSize !== undefined
    const effectivePage = page ?? 1
    const pageSize = requestedPageSize ?? 20
    const where: any = { tenantId: req.user.tenantId }
    if (SUPPLIER_ROLES.has(role)) {
      if (!supplierId) return paginated ? { items: [], total: 0, page: effectivePage, pageSize } : []
      where.id = supplierId
    } else if (!FINANCE_ROLES.has(role)) {
      // 订货岗位只需要启用供应商候选，不得看到银行、联系人和账期等敏感主数据。
      where.status = 'ENABLED'
    } else if (status) where.status = status

    const select = FINANCE_ROLES.has(role) || SUPPLIER_ROLES.has(role) ? undefined : SAFE_SELECT

    // 不传 page/pageSize 时返回全量（兼容下拉框），缓存 10 分钟
    if (!paginated) {
      // 角色与 supplierId 必须进入缓存键，防止管理员完整数据被其他角色命中同一缓存。
      return cached(`suppliers:full:${req.user.tenantId}:${role}:${supplierId || 'none'}:${status || 'all'}`, 600, () =>
        prisma.supplier.findMany({ where, ...(select ? { select } : {}), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      )
    }
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({
        where, ...(select ? { select } : {}), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (effectivePage - 1) * pageSize, take: pageSize,
      }),
      prisma.supplier.count({ where }),
    ])
    return { items, total, page: effectivePage, pageSize }
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
      const supplier = await prisma.$transaction(async tx => {
        const created = await tx.supplier.create({ data: { tenantId, ...parsed.data } as any })
        await tx.opLog.create({
          data: {
            tenantId, userId: req.user.userId, role,
            action: `创建供应商：${created.name}`,
            entityType: 'Supplier', targetId: created.id,
            metadata: { no: created.no, changedFields: Object.keys(parsed.data) },
          },
        })
        return created
      })
      void invalidatePattern(`suppliers:full:${tenantId}:*`)
      return reply.status(201).send(supplier)
    } catch (e: any) {
      if (e.code === 'P2002') return reply.status(409).send({ error: '供应商编号已存在' })
      req.log.error({ err: e }, 'supplier create failed')
      return reply.status(500).send({ error: '创建失败（请检查日志）' })
    }
  })

  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    // P0: 仅管理岗位可改供应商资料 (含银行账号), 否则供应商账号能改别家公司收款行户
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权修改供应商资料' })
    const parsed = supplierUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    if (Object.keys(parsed.data).length === 0) return reply.status(400).send({ error: '没有可更新字段' })
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier:${idParsed.data}`}))::text AS locked`
      const current = await tx.supplier.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!current) throw { statusCode: 404, message: '供应商不存在' }
      const saved = await tx.supplier.update({ where: { id: current.id }, data: parsed.data as any })
      await tx.opLog.create({
        data: {
          tenantId, userId: req.user.userId, role,
          action: `更新供应商：${saved.name}`,
          entityType: 'Supplier', targetId: saved.id,
          // 只记字段名，银行账号、联系人等值不进入操作日志。
          metadata: { changedFields: Object.keys(parsed.data) },
        },
      })
      return saved
    })
    void invalidatePattern(`suppliers:full:${tenantId}:*`)
    return updated
  })

  app.patch('/:id/toggle', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'FINANCE', 'SUPER_ADMIN'].includes(role))
      return reply.status(403).send({ error: '无权启用/停用供应商' })
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '供应商 ID 格式不正确' })
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier:${idParsed.data}`}))::text AS locked`
      const current = await tx.supplier.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!current) throw { statusCode: 404, message: '供应商不存在' }
      const saved = await tx.supplier.update({
        where: { id: current.id },
        data: { status: current.status === 'ENABLED' ? 'DISABLED' : 'ENABLED' },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId: req.user.userId, role,
          action: `${saved.status === 'ENABLED' ? '启用' : '停用'}供应商：${saved.name}`,
          entityType: 'Supplier', targetId: saved.id,
          metadata: { fromStatus: current.status, toStatus: saved.status },
        },
      })
      return saved
    })
    void invalidatePattern(`suppliers:full:${tenantId}:*`)
    return updated
  })
}
