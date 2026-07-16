import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

// 注意: PURCHASER 是 v2 legacy 别名, 实际等同于 MANAGER (店长权限).
// 已从申请白名单移除, 防止供应商误申请→拿店长权限的安全漏洞.
const APPLICABLE_ROLES = [
  'MANAGER', 'KITCHEN_LEAD', 'CHEF_DIRECTOR', 'FINANCE', 'ENGINEERING',
  'SUPPLIER_OWNER',  // 注册新供应商公司 → 自动创建 Supplier 实体
  'SUPPLIER_STAFF',  // 加入已有供应商 → 绑定到指定 Supplier
] as const
// BOSS 是 v2 别名（schema 注释说 "ADMIN 品牌管理员（v2 = 老板 BOSS）"），
// 跟 documents.ts / capital.ts 保持一致
const APPROVE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'BOSS'])
const PHONE_RE = /^1[3-9]\d{9}$/

const entityIdSchema = z.string().trim().min(1).max(64)
const tenantSlugSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i, '租户标识格式不正确')

const applySchema = z.object({
  name:     z.string().trim().min(1, '请填写姓名').max(20),
  phone:    z.string().trim().regex(PHONE_RE, '手机号格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(40),
  requestedRole: z.enum(APPLICABLE_ROLES, { errorMap: () => ({ message: '角色无效' }) }),
  reason:   z.string().trim().max(200).optional(),
  tenantSlug: tenantSlugSchema.default('dianjie'),
  // 供应商专用 (二选一):
  supplierId:   entityIdSchema.optional(),   // 加入已有供应商
  supplierName: z.string().trim().max(80).optional(),  // 注册新供应商公司名
  // 店长/厨师长专用: 申请时必须指定门店
  requestedStoreId: entityIdSchema.optional(),
}).strict().refine(
  (d) => d.requestedRole !== 'SUPPLIER_OWNER' || !!d.supplierName,
  { message: '注册新供应商需填写公司名称', path: ['supplierName'] },
).refine(
  (d) => d.requestedRole !== 'SUPPLIER_STAFF' || !!d.supplierId,
  { message: '加入已有供应商需选择公司', path: ['supplierId'] },
).refine(
  (d) => !['MANAGER', 'KITCHEN_LEAD'].includes(d.requestedRole) || !!d.requestedStoreId,
  { message: '店长 / 厨师长 申请时必须选择门店', path: ['requestedStoreId'] },
)

const approveSchema = z.object({
  storeId: entityIdSchema.optional(),  // MANAGER/KITCHEN_LEAD 可选绑店
}).strict()
const rejectSchema = z.object({
  reason: z.string().trim().min(1, '请说明拒绝原因').max(200),
}).strict()
const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
}).strict()

/** 公开申请端点: POST /api/auth/apply (挂在 auth 路由 prefix 下) */
export const publicApplyRoute: FastifyPluginAsync = async (app) => {
  app.post('/apply', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req: any, reply: any) => {
    const parsed = applySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message })
    }
    const d = parsed.data

    const tenant = await prisma.tenant.findUnique({ where: { slug: d.tenantSlug } })
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(404).send({ error: '租户不存在' })
    }

    const passwordHash = await bcrypt.hash(d.password, 10)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`public-application:${tenant.id}:${d.phone}`}))::text AS locked`
      const existingUser = await tx.user.findUnique({
        where: { tenantId_phone: { tenantId: tenant.id, phone: d.phone } },
        select: { id: true },
      })
      if (existingUser) return { error: '该手机号已注册, 请直接登录' }
      const pending = await tx.userApplication.findFirst({
        where: { tenantId: tenant.id, phone: d.phone, status: 'PENDING' }, select: { id: true },
      })
      if (pending) return { error: '该手机号已有待审批的申请' }

      if (d.requestedRole === 'SUPPLIER_STAFF' && d.supplierId) {
        const supplier = await tx.supplier.findFirst({
          where: { id: d.supplierId, tenantId: tenant.id, status: 'ENABLED' }, select: { id: true },
        })
        if (!supplier) return { error: '所选供应商不存在或已停用' }
      }
      if (['MANAGER', 'KITCHEN_LEAD'].includes(d.requestedRole) && d.requestedStoreId) {
        const store = await tx.store.findFirst({
          where: { id: d.requestedStoreId, tenantId: tenant.id, status: 'ENABLED' }, select: { id: true },
        })
        if (!store) return { error: '所选门店不存在或已停用' }
      }

      await tx.userApplication.create({
        data: {
          tenantId: tenant.id,
          name: d.name, phone: d.phone, passwordHash,
          requestedRole: d.requestedRole as any,
          reason: d.reason || null,
          supplierId: d.supplierId || null,
          supplierName: d.supplierName || null,
          requestedStoreId: d.requestedStoreId || null,
        },
      })
      return { ok: true }
    })
    if ('error' in result) return reply.status(400).send({ error: result.error })
    return reply.status(201).send({ ok: true, message: '申请已提交, 等待老板审批' })
  })

  // 公开端点: 列出本租户的可加入供应商 (apply 表单"加入已有公司"用)
  app.get('/supplier-list', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req: any, reply: any) => {
    const parsed = z.object({ tenantSlug: tenantSlugSchema.default('dianjie') }).strict().safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const slug = parsed.data.tenantSlug
    const tenant = await prisma.tenant.findUnique({ where: { slug } })
    if (!tenant) return reply.status(404).send({ error: '租户不存在' })
    const list = await prisma.supplier.findMany({
      where: { tenantId: tenant.id, status: 'ENABLED' },
      select: { id: true, name: true, no: true },
      orderBy: { name: 'asc' },
    })
    return list
  })

  // 公开端点: 列出本租户的门店 (apply 表单"店长/厨师长选店"用)
  app.get('/store-list', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req: any, reply: any) => {
    const parsed = z.object({ tenantSlug: tenantSlugSchema.default('dianjie') }).strict().safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const slug = parsed.data.tenantSlug
    const tenant = await prisma.tenant.findUnique({ where: { slug } })
    if (!tenant) return reply.status(404).send({ error: '租户不存在' })
    const list = await prisma.store.findMany({
      where: { tenantId: tenant.id, status: 'ENABLED' },
      select: { id: true, name: true, no: true },
      orderBy: { no: 'asc' },
    })
    return list
  })
}

/** 老板侧管理: GET / approve / reject */
export const applicationRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/applications?status=PENDING (默认 PENDING + 30 天内 REJECTED)
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!APPROVE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { status } = parsed.data
    const where: any = { tenantId }
    if (status) {
      where.status = status
    } else {
      const cutoff = new Date(Date.now() - 30 * 86400_000)
      where.OR = [
        { status: 'PENDING' },
        { status: 'REJECTED', createdAt: { gte: cutoff } },
        { status: 'APPROVED', createdAt: { gte: cutoff } },
      ]
    }
    const apps = await prisma.userApplication.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })
    // 富化: 把 supplierId / requestedStoreId 对应的实体名一起带回
    const supIds = [...new Set(apps.filter(a => a.supplierId).map(a => a.supplierId!))]
    const sups = supIds.length === 0 ? [] : await prisma.supplier.findMany({
      where: { id: { in: supIds } }, select: { id: true, name: true, no: true },
    })
    const supMap = Object.fromEntries(sups.map(s => [s.id, s]))
    const stIds = [...new Set(apps.filter(a => a.requestedStoreId).map(a => a.requestedStoreId!))]
    const stores = stIds.length === 0 ? [] : await prisma.store.findMany({
      where: { id: { in: stIds } }, select: { id: true, name: true, no: true },
    })
    const stMap = Object.fromEntries(stores.map(s => [s.id, s]))
    return apps.map(a => ({
      ...a,
      joinedSupplier: a.supplierId ? supMap[a.supplierId] || null : null,
      requestedStore: a.requestedStoreId ? stMap[a.requestedStoreId] || null : null,
    }))
  })

  // GET /api/applications/pending-count
  app.get('/pending-count', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!APPROVE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const count = await prisma.userApplication.count({ where: { tenantId, status: 'PENDING' } })
    return { count }
  })

  // POST /api/applications/:id/approve
  app.post('/:id/approve', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!APPROVE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = approveSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '申请标识格式不正确' })
    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`application:${idParsed.data}`}))::text AS locked`
        const appl = await tx.userApplication.findFirst({ where: { id: idParsed.data, tenantId } })
        if (!appl) return { status: 404, error: '申请不存在' }
        if (appl.status !== 'PENDING') return { status: 400, error: '该申请已处理' }

        const storeId = parsed.data.storeId || appl.requestedStoreId || null
        if (['MANAGER', 'KITCHEN_LEAD'].includes(appl.requestedRole) && !storeId) {
          return { status: 400, error: `${appl.requestedRole === 'MANAGER' ? '店长' : '厨师长'}角色必须绑定门店` }
        }
        if (storeId) {
          const store = await tx.store.findFirst({ where: { id: storeId, tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!store) return { status: 400, error: '门店不存在或已停用' }
        }
        const exists = await tx.user.findUnique({
          where: { tenantId_phone: { tenantId, phone: appl.phone } }, select: { id: true },
        })
        if (exists) return { status: 400, error: '该手机号已注册, 请拒绝该申请' }

        let finalSupplierId: string | null = null
        let createdSupplierNote = ''
        if (appl.requestedRole === 'SUPPLIER_STAFF') {
          if (!appl.supplierId) return { status: 400, error: '该申请缺少供应商ID, 请拒绝并让其重新申请' }
          const supplier = await tx.supplier.findFirst({
            where: { id: appl.supplierId, tenantId, status: 'ENABLED' }, select: { id: true },
          })
          if (!supplier) return { status: 400, error: '所选供应商不存在或已停用' }
          finalSupplierId = supplier.id
        } else if (appl.requestedRole === 'SUPPLIER_OWNER') {
          if (!appl.supplierName) return { status: 400, error: '该申请缺少供应商公司名, 请拒绝并让其重新申请' }
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-sequence:${tenantId}`}))::text AS locked`
          const supplierNos = await tx.supplier.findMany({
            where: { tenantId, no: { startsWith: 'SUP' } }, select: { no: true },
          })
          const next = supplierNos.reduce((max, item) => {
            const match = /^SUP(\d+)$/.exec(item.no)
            return match ? Math.max(max, Number(match[1])) : max
          }, 0) + 1
          const newNo = `SUP${String(next).padStart(3, '0')}`
          const supplier = await tx.supplier.create({
            data: {
              tenantId, no: newNo, name: appl.supplierName,
              contactName: appl.name, contactPhone: appl.phone, status: 'ENABLED',
            },
          })
          finalSupplierId = supplier.id
          createdSupplierNote = ` + 创建供应商 ${newNo} ${appl.supplierName}`
        }

        await tx.user.create({
          data: {
            tenantId, name: appl.name, phone: appl.phone,
            email: `${appl.phone}@phone.dianjie`, password: appl.passwordHash,
            role: appl.requestedRole, storeId,
            storeIds: storeId ? [storeId] : [],
            supplierId: finalSupplierId, status: 'ACTIVE',
          },
        })
        await tx.userApplication.update({
          where: { id: appl.id },
          data: { status: 'APPROVED', decidedById: operatorId, decidedAt: new Date() },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId: operatorId, role,
            action: `通过账号申请 ${appl.name} (${appl.phone})${createdSupplierNote}`,
            entityType: 'UserApplication', targetId: appl.id,
          },
        })
        return { status: 200, ok: true }
      })
      if ('error' in result) return reply.status(result.status).send({ error: result.error })
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(400).send({ error: '手机号、邮箱或供应商编号已被占用' })
      throw error
    }
    return { ok: true }
  })

  // POST /api/applications/:id/reject
  app.post('/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!APPROVE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = rejectSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '申请标识格式不正确' })
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`application:${idParsed.data}`}))::text AS locked`
      const appl = await tx.userApplication.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!appl) return { status: 404, error: '申请不存在' }
      if (appl.status !== 'PENDING') return { status: 400, error: '该申请已处理' }
      await tx.userApplication.update({
        where: { id: appl.id },
        data: {
          status: 'REJECTED', decidedById: operatorId,
          decidedAt: new Date(), rejectReason: parsed.data.reason,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId, userId: operatorId, role,
          action: `拒绝账号申请 ${appl.name} (${appl.phone}): ${parsed.data.reason}`,
          entityType: 'UserApplication', targetId: appl.id,
        },
      })
      return { status: 200, ok: true }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return { ok: true }
  })
}
