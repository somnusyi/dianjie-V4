import crypto from 'crypto'
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
