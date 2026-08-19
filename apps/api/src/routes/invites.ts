import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const INVITER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])
const INVITABLE_ROLES = ['MANAGER','KITCHEN_LEAD','CHEF_DIRECTOR','FINANCE','PURCHASER','ENGINEERING','SUPPLY_CHAIN','SUPPLIER_OWNER','SUPPLIER_STAFF','REGIONAL_MANAGER'] as const
const STORE_BOUND_ROLES = new Set(['MANAGER','KITCHEN_LEAD','REGIONAL_MANAGER'])
const SUPPLIER_BOUND_ROLES = new Set(['SUPPLIER_OWNER','SUPPLIER_STAFF'])
const PHONE_RE = /^1[3-9]\d{9}$/
const entityIdSchema = z.string().trim().min(1).max(64)
const tokenSchema = z.string().min(32).max(64).regex(/^[A-Za-z0-9_-]+$/, '邀请链接格式不正确')

const createSchema = z.object({
  role: z.enum(INVITABLE_ROLES, { errorMap: () => ({ message: '角色无效' }) }),
  storeId:    entityIdSchema.optional(),
  storeIds:   z.array(entityIdSchema).max(50).optional(), // 多店：优先于 storeId
  supplierId: entityIdSchema.optional(),
  note:       z.string().trim().max(60).optional(),
  expiresHours: z.number().int().min(1).max(168).default(24),
}).strict()

const acceptSchema = z.object({
  name:     z.string().trim().min(1, '请填写姓名').max(20),
  phone:    z.string().trim().regex(PHONE_RE, '手机号格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(40),
}).strict()

function genToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** /api/invites — 老板侧 */
export const inviteRoutes: FastifyPluginAsync = async (app) => {

  // 创建邀请链接
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    // 多店归一：storeIds 优先，回退单店字段；去重保序
    const storeIds = [...new Set(d.storeIds?.length ? d.storeIds : (d.storeId ? [d.storeId] : []))]
    if (STORE_BOUND_ROLES.has(d.role)) {
      if (storeIds.length === 0) return reply.status(400).send({ error: '该角色必须绑定门店' })
      const stores = await prisma.store.findMany({ where: { id: { in: storeIds }, tenantId, status: 'ENABLED' }, select: { id: true } })
      if (stores.length !== storeIds.length) return reply.status(400).send({ error: '门店不存在' })
    }
    if (SUPPLIER_BOUND_ROLES.has(d.role)) {
      if (!d.supplierId) return reply.status(400).send({ error: '该角色必须绑定供应商' })
      const sup = await prisma.supplier.findFirst({ where: { id: d.supplierId, tenantId, status: 'ENABLED' } })
      if (!sup) return reply.status(400).send({ error: '供应商不存在' })
    }

    const inv = await prisma.$transaction(async tx => {
      const created = await tx.inviteToken.create({
        data: {
          tenantId, role: d.role as any,
          storeId: storeIds[0] ?? null,
          storeIds,
          supplierId: d.supplierId || null,
          invitedById: userId,
          note: d.note || null,
          token: genToken(),
          expiresAt: new Date(Date.now() + d.expiresHours * 3600_000),
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `创建账号邀请 ${d.role}`,
          entityType: 'InviteToken', targetId: created.id,
          metadata: { role: d.role, storeId: storeIds[0] ?? null, storeIds, supplierId: d.supplierId || null },
        },
      })
      return created
    })
    return reply.status(201).send(inv)
  })

  // 列表 (active = 未消费 + 未撤销 + 未过期; 也返回最近 7 天历史)
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const cutoff = new Date(Date.now() - 7 * 86400_000)
    const list = await prisma.inviteToken.findMany({
      where: { tenantId, OR: [{ consumedAt: null, revokedAt: null }, { createdAt: { gte: cutoff } }] },
      orderBy: { createdAt: 'desc' },
    })
    // 富化 store / supplier 名字（含多店数组）
    const storeIdSet = [...new Set(list.flatMap(l => [...(l.storeId ? [l.storeId] : []), ...(l.storeIds ?? [])]))]
    const supIds   = [...new Set(list.map(l => l.supplierId).filter(Boolean) as string[])]
    const [stores, suppliers] = await Promise.all([
      storeIdSet.length ? prisma.store.findMany({ where: { id: { in: storeIdSet } }, select: { id: true, name: true } }) : [],
      supIds.length   ? prisma.supplier.findMany({ where: { id: { in: supIds } }, select: { id: true, name: true } })   : [],
    ])
    const sMap = Object.fromEntries(stores.map(s => [s.id, s.name]))
    const supMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]))
    return list.map(l => ({
      ...l,
      storeName: l.storeId ? sMap[l.storeId] : null,
      storeNames: (l.storeIds ?? []).map(id => sMap[id]).filter(Boolean),
      supplierName: l.supplierId ? supMap[l.supplierId] : null,
    }))
  })

  // 撤销
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '邀请标识格式不正确' })
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite:${idParsed.data}`}))::text AS locked`
      const inv = await tx.inviteToken.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!inv) return { status: 404, error: '邀请不存在' }
      if (inv.consumedAt) return { status: 400, error: '已被使用, 不能撤销' }
      if (inv.revokedAt) return { status: 400, error: '已撤销' }
      await tx.inviteToken.update({ where: { id: inv.id }, data: { revokedAt: new Date() } })
      await tx.opLog.create({
        data: { tenantId, userId, role, action: '撤销账号邀请', entityType: 'InviteToken', targetId: inv.id },
      })
      return { status: 200, ok: true }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return { ok: true }
  })
}

/** /api/invite-accept — 公开 token 流程 */
export const inviteAcceptRoutes: FastifyPluginAsync = async (app) => {

  // GET /:token — 查看邀请详情 (公开)
  app.get('/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req: any, reply: any) => {
    const tokenParsed = tokenSchema.safeParse(req.params.token)
    if (!tokenParsed.success) return reply.status(400).send({ error: tokenParsed.error.issues[0].message })
    const t = tokenParsed.data
    const inv = await prisma.inviteToken.findUnique({ where: { token: t } })
    if (!inv) return reply.status(404).send({ error: '邀请链接无效' })
    if (inv.revokedAt) return reply.status(400).send({ error: '邀请已被老板撤销' })
    if (inv.consumedAt) return reply.status(400).send({ error: '邀请已被使用' })
    if (inv.expiresAt < new Date()) return reply.status(400).send({ error: '邀请已过期, 请联系老板重新发' })

    const tenant = await prisma.tenant.findUnique({ where: { id: inv.tenantId }, select: { name: true } })
    const invStoreIds = inv.storeIds?.length ? inv.storeIds : (inv.storeId ? [inv.storeId] : [])
    const stores = invStoreIds.length
      ? await prisma.store.findMany({ where: { id: { in: invStoreIds } }, select: { id: true, name: true } })
      : []
    const supplier = inv.supplierId ? await prisma.supplier.findUnique({ where: { id: inv.supplierId }, select: { name: true } }) : null
    return {
      role: inv.role, note: inv.note, expiresAt: inv.expiresAt,
      tenantName: tenant?.name || '',
      storeName: stores[0]?.name || null,
      storeNames: stores.map(s => s.name),
      supplierName: supplier?.name || null,
    }
  })

  // POST /:token/accept — 激活账号 (公开)
  app.post('/:token/accept', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req: any, reply: any) => {
    const tokenParsed = tokenSchema.safeParse(req.params.token)
    if (!tokenParsed.success) return reply.status(400).send({ error: tokenParsed.error.issues[0].message })
    const t = tokenParsed.data
    const parsed = acceptSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const preliminary = await prisma.inviteToken.findUnique({ where: { token: t }, select: { id: true } })
    if (!preliminary) return reply.status(404).send({ error: '邀请链接无效' })
    const passwordHash = await bcrypt.hash(d.password, 10)
    const emailFinal = `${d.phone}@phone.dianjie`
    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite:${preliminary.id}`}))::text AS locked`
        const inv = await tx.inviteToken.findUnique({ where: { id: preliminary.id } })
        if (!inv) return { status: 404, error: '邀请链接无效' }
        if (inv.revokedAt) return { status: 400, error: '邀请已被撤销' }
        if (inv.consumedAt) return { status: 400, error: '邀请已被使用' }
        if (inv.expiresAt < new Date()) return { status: 400, error: '邀请已过期' }

        const tenant = await tx.tenant.findFirst({ where: { id: inv.tenantId, status: 'ACTIVE' }, select: { id: true } })
        if (!tenant) return { status: 400, error: '所属租户已停用' }
        const invStoreIds = inv.storeIds?.length ? inv.storeIds : (inv.storeId ? [inv.storeId] : [])
        if (invStoreIds.length > 0) {
          const stores = await tx.store.findMany({ where: { id: { in: invStoreIds }, tenantId: inv.tenantId, status: 'ENABLED' }, select: { id: true } })
          if (stores.length !== invStoreIds.length) return { status: 400, error: '邀请关联门店不存在或已停用' }
        }
        if (inv.supplierId) {
          const supplier = await tx.supplier.findFirst({ where: { id: inv.supplierId, tenantId: inv.tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!supplier) return { status: 400, error: '邀请关联供应商不存在或已停用' }
        }
        const exists = await tx.user.findUnique({
          where: { tenantId_phone: { tenantId: inv.tenantId, phone: d.phone } }, select: { id: true },
        })
        if (exists) return { status: 400, error: '该手机号已注册, 请直接登录' }

        const user = await tx.user.create({
          data: {
            tenantId: inv.tenantId,
            name: d.name,
            phone: d.phone,
            email: emailFinal,
            password: passwordHash,
            role: inv.role,
            storeId: invStoreIds[0] ?? null,
            storeIds: invStoreIds,
            supplierId: inv.supplierId || null,
            status: 'ACTIVE',
          },
        })
        await tx.inviteToken.update({
          where: { id: inv.id }, data: { consumedAt: new Date(), consumedByUserId: user.id },
        })
        await tx.opLog.create({
          data: {
            tenantId: inv.tenantId, userId: user.id, role: inv.role,
            action: `通过邀请链接激活账号 ${user.name}`,
            entityType: 'InviteToken', targetId: inv.id,
          },
        })
        return { status: 201, ok: true }
      })
      if ('error' in result) return reply.status(result.status).send({ error: result.error })
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(400).send({ error: '该手机号已注册, 请直接登录' })
      throw error
    }
    return reply.status(201).send({ ok: true })
  })
}
