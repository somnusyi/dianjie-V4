import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const UPSTREAM_INVITER_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
const upstreamSupplierIdSchema = z.string().trim().min(1).max(64)
const createUpstreamSupplierInviteSchema = z.object({
  role: z.enum(['SUPPLIER_OWNER', 'SUPPLIER_STAFF']).default('SUPPLIER_STAFF'),
  note: z.string().trim().max(60).optional(),
  expiresHours: z.number().int().min(1).max(168).default(24),
}).strict()

const createSupplierAccountSchema = z.object({
  name: z.string().trim().min(1, '请填写姓名').max(20),
  phone: z.string().trim().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  password: z.string().min(6, '密码至少6位').max(40),
}).strict()
const ACCOUNT_CREATED_ACTION = '供应链直接添加供应商账号'

function upstreamInviteToken() {
  return crypto.randomBytes(24).toString('base64url')
}
/**
 * 供应链受限邀请入口。
 *
 * SUPPLY_CHAIN 不能使用通用 /api/invites 创建内部员工，只能在这里为已启用的
 * WAREHOUSE_UPSTREAM 合作方创建 OWNER/STAFF 账号，避免扩大通用账号管理权限。
 */
export const upstreamSupplierInviteRoutes: FastifyPluginAsync = async (app) => {
  app.get('/supplier-accounts/history', auth(app), async (req: any, reply: any) => {
    if (!UPSTREAM_INVITER_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权限' })
    const query = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).strict().safeParse(req.query)
    if (!query.success) return reply.status(400).send({ error: '历史页码格式不正确' })
    const rows = await prisma.opLog.findMany({
      where: { tenantId: req.user.tenantId, entityType: 'User', action: ACCOUNT_CREATED_ACTION },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: query.data.page * 100, take: 101,
      select: { metadata: true },
    })
    const items = rows.slice(0, 100).map(row => {
      const data = row.metadata as Record<string, unknown> | null
      return { company: String(data?.supplierName || ''), name: String(data?.name || ''), phone: String(data?.phone || '') }
    })
    return { items, hasMore: rows.length > 100 }
  })

  app.post('/suppliers/:supplierId/accounts', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!UPSTREAM_INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const companyId = upstreamSupplierIdSchema.safeParse(req.params.supplierId)
    const parsed = createSupplierAccountSchema.safeParse(req.body)
    if (!companyId.success || !parsed.success) return reply.status(400).send({ error: !parsed.success ? parsed.error.issues[0].message : '供应商标识格式不正确' })
    const d = parsed.data
    const passwordHash = await bcrypt.hash(d.password, 10)
    try {
      const result = await prisma.$transaction(async tx => {
        const supplier = await tx.supplier.findFirst({ where: { id: companyId.data, tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } }, select: { id: true, name: true } })
        if (!supplier) return { status: 404, error: '上游供应商不存在或已停用' }
        const existing = await tx.user.findUnique({ where: { tenantId_phone: { tenantId, phone: d.phone } }, select: { id: true } })
        if (existing) return { status: 409, error: '该手机号已有账号，请核对原账号；不会覆盖或更换所属公司' }
        const user = await tx.user.create({ data: { tenantId, name: d.name, phone: d.phone, email: `${d.phone}@phone.dianjie`, password: passwordHash, role: 'SUPPLIER_OWNER', supplierId: supplier.id, storeIds: [], status: 'ACTIVE' }, select: { id: true } })
        await tx.opLog.create({ data: { tenantId, userId, role, entityType: 'User', targetId: user.id, action: ACCOUNT_CREATED_ACTION, metadata: { supplierId: supplier.id, supplierName: supplier.name, name: d.name, phone: d.phone } } })
        return { company: supplier.name, name: d.name, phone: d.phone }
      })
      if ('error' in result) return reply.status(result.status).send({ error: result.error })
      return reply.status(201).send(result)
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(409).send({ error: '该手机号已有账号，请核对原账号；不会覆盖或更换所属公司' })
      throw error
    }
  })

  app.post('/suppliers/:supplierId/invites', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!UPSTREAM_INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const supplierIdParsed = upstreamSupplierIdSchema.safeParse(req.params.supplierId)
    if (!supplierIdParsed.success) return reply.status(400).send({ error: '供应商标识格式不正确' })
    const parsed = createUpstreamSupplierInviteSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const supplierId = supplierIdParsed.data
    const d = parsed.data

    const supplier = await prisma.supplier.findFirst({
      where: {
        id: supplierId,
        tenantId,
        status: 'ENABLED',
        businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
      },
      select: { id: true, name: true },
    })
    if (!supplier) return reply.status(404).send({ error: '上游供应商不存在或已停用' })

    const invite = await prisma.$transaction(async tx => {
      const created = await tx.inviteToken.create({
        data: {
          tenantId,
          role: d.role,
          storeIds: [],
          supplierId,
          invitedById: userId,
          note: d.note || null,
          token: upstreamInviteToken(),
          expiresAt: new Date(Date.now() + d.expiresHours * 3_600_000),
        },
      })
      await tx.opLog.create({
        data: {
          tenantId,
          userId,
          role,
          action: `创建上游供应商账号邀请 ${d.role}`,
          entityType: 'InviteToken',
          targetId: created.id,
          metadata: { supplierId, supplierName: supplier.name, invitedRole: d.role },
        },
      })
      return created
    })

    return reply.status(201).send({ ...invite, supplierName: supplier.name })
  })

  app.get('/suppliers/:supplierId/invites', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!UPSTREAM_INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const supplierIdParsed = upstreamSupplierIdSchema.safeParse(req.params.supplierId)
    if (!supplierIdParsed.success) return reply.status(400).send({ error: '供应商标识格式不正确' })

    return prisma.inviteToken.findMany({
      where: {
        tenantId,
        supplierId: supplierIdParsed.data,
        role: { in: ['SUPPLIER_OWNER', 'SUPPLIER_STAFF'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })
}
