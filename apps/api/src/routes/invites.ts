import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const INVITER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])
const INVITABLE_ROLES = ['MANAGER','KITCHEN_LEAD','CHEF_DIRECTOR','FINANCE','PURCHASER','ENGINEERING','SUPPLIER_OWNER','SUPPLIER_STAFF'] as const
const STORE_BOUND_ROLES = new Set(['MANAGER','KITCHEN_LEAD'])
const SUPPLIER_BOUND_ROLES = new Set(['SUPPLIER_OWNER','SUPPLIER_STAFF'])
const PHONE_RE = /^1[3-9]\d{9}$/

const createSchema = z.object({
  role: z.enum(INVITABLE_ROLES, { errorMap: () => ({ message: '角色无效' }) }),
  storeId:    z.string().optional(),
  supplierId: z.string().optional(),
  note:       z.string().trim().max(60).optional(),
  expiresHours: z.number().int().min(1).max(168).default(24),
})

const acceptSchema = z.object({
  name:     z.string().trim().min(1, '请填写姓名').max(20),
  phone:    z.string().trim().regex(PHONE_RE, '手机号格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(40),
})

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

    if (STORE_BOUND_ROLES.has(d.role)) {
      if (!d.storeId) return reply.status(400).send({ error: '该角色必须绑定门店' })
      const s = await prisma.store.findFirst({ where: { id: d.storeId, tenantId } })
      if (!s) return reply.status(400).send({ error: '门店不存在' })
    }
    if (SUPPLIER_BOUND_ROLES.has(d.role)) {
      if (!d.supplierId) return reply.status(400).send({ error: '该角色必须绑定供应商' })
      const sup = await prisma.supplier.findFirst({ where: { id: d.supplierId, tenantId } })
      if (!sup) return reply.status(400).send({ error: '供应商不存在' })
    }

    const inv = await prisma.inviteToken.create({
      data: {
        tenantId, role: d.role as any,
        storeId: d.storeId || null,
        supplierId: d.supplierId || null,
        invitedById: userId,
        note: d.note || null,
        token: genToken(),
        expiresAt: new Date(Date.now() + d.expiresHours * 3600_000),
      },
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
      include: {},
    })
    // 富化 store / supplier 名字
    const storeIds = [...new Set(list.map(l => l.storeId).filter(Boolean) as string[])]
    const supIds   = [...new Set(list.map(l => l.supplierId).filter(Boolean) as string[])]
    const [stores, suppliers] = await Promise.all([
      storeIds.length ? prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }) : [],
      supIds.length   ? prisma.supplier.findMany({ where: { id: { in: supIds } }, select: { id: true, name: true } })   : [],
    ])
    const sMap = Object.fromEntries(stores.map(s => [s.id, s.name]))
    const supMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]))
    return list.map(l => ({
      ...l,
      storeName: l.storeId ? sMap[l.storeId] : null,
      supplierName: l.supplierId ? supMap[l.supplierId] : null,
    }))
  })

  // 撤销
  app.delete('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!INVITER_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const inv = await prisma.inviteToken.findFirst({ where: { id: req.params.id, tenantId } })
    if (!inv) return reply.status(404).send({ error: '邀请不存在' })
    if (inv.consumedAt) return reply.status(400).send({ error: '已被使用, 不能撤销' })
    if (inv.revokedAt) return reply.status(400).send({ error: '已撤销' })
    await prisma.inviteToken.update({ where: { id: inv.id }, data: { revokedAt: new Date() } })
    return { ok: true }
  })
}

/** /api/invite-accept — 公开 token 流程 */
export const inviteAcceptRoutes: FastifyPluginAsync = async (app) => {

  // GET /:token — 查看邀请详情 (公开)
  app.get('/:token', async (req: any, reply: any) => {
    const t = req.params.token
    const inv = await prisma.inviteToken.findUnique({ where: { token: t } })
    if (!inv) return reply.status(404).send({ error: '邀请链接无效' })
    if (inv.revokedAt) return reply.status(400).send({ error: '邀请已被老板撤销' })
    if (inv.consumedAt) return reply.status(400).send({ error: '邀请已被使用' })
    if (inv.expiresAt < new Date()) return reply.status(400).send({ error: '邀请已过期, 请联系老板重新发' })

    const tenant = await prisma.tenant.findUnique({ where: { id: inv.tenantId }, select: { name: true } })
    const store = inv.storeId ? await prisma.store.findUnique({ where: { id: inv.storeId }, select: { name: true } }) : null
    const supplier = inv.supplierId ? await prisma.supplier.findUnique({ where: { id: inv.supplierId }, select: { name: true } }) : null
    return {
      role: inv.role, note: inv.note, expiresAt: inv.expiresAt,
      tenantName: tenant?.name || '',
      storeName: store?.name || null,
      supplierName: supplier?.name || null,
    }
  })

  // POST /:token/accept — 激活账号 (公开)
  app.post('/:token/accept', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req: any, reply: any) => {
    const t = req.params.token
    const parsed = acceptSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data

    const inv = await prisma.inviteToken.findUnique({ where: { token: t } })
    if (!inv) return reply.status(404).send({ error: '邀请链接无效' })
    if (inv.revokedAt) return reply.status(400).send({ error: '邀请已被撤销' })
    if (inv.consumedAt) return reply.status(400).send({ error: '邀请已被使用' })
    if (inv.expiresAt < new Date()) return reply.status(400).send({ error: '邀请已过期' })

    // 手机号唯一性
    const exists = await prisma.user.findUnique({
      where: { tenantId_phone: { tenantId: inv.tenantId, phone: d.phone } },
    })
    if (exists) return reply.status(400).send({ error: '该手机号已注册, 请直接登录' })

    const passwordHash = await bcrypt.hash(d.password, 10)
    const emailFinal = `${d.phone}@phone.dianjie`

    const [user] = await prisma.$transaction([
      prisma.user.create({
        data: {
          tenantId: inv.tenantId,
          name: d.name,
          phone: d.phone,
          email: emailFinal,
          password: passwordHash,
          role: inv.role,
          storeId: inv.storeId || null,
          supplierId: inv.supplierId || null,
          status: 'ACTIVE',
        },
      }),
      prisma.inviteToken.update({
        where: { id: inv.id },
        data: { consumedAt: new Date(), consumedByUserId: undefined },
      }),
    ])

    // 记录激活者 id
    await prisma.inviteToken.update({
      where: { id: inv.id },
      data: { consumedByUserId: user.id },
    })

    await prisma.opLog.create({
      data: { tenantId: inv.tenantId, userId: user.id, action: `通过邀请链接激活账号 ${user.name}`, entityType: 'InviteToken', targetId: inv.id },
    })
    return reply.status(201).send({ ok: true })
  })
}
