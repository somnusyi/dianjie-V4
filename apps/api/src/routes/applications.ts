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

const applySchema = z.object({
  name:     z.string().trim().min(1, '请填写姓名').max(20),
  phone:    z.string().trim().regex(PHONE_RE, '手机号格式不正确'),
  password: z.string().min(6, '密码至少 6 位').max(40),
  requestedRole: z.enum(APPLICABLE_ROLES, { errorMap: () => ({ message: '角色无效' }) }),
  reason:   z.string().trim().max(200).optional(),
  tenantSlug: z.string().default('dianjie'),
  // 供应商专用 (二选一):
  supplierId:   z.string().optional(),   // 加入已有供应商
  supplierName: z.string().trim().max(80).optional(),  // 注册新供应商公司名
  // 店长/厨师长专用: 申请时必须指定门店
  requestedStoreId: z.string().optional(),
}).refine(
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
  storeId: z.string().optional(),  // MANAGER/KITCHEN_LEAD 可选绑店
})
const rejectSchema = z.object({
  reason: z.string().trim().min(1, '请说明拒绝原因').max(200),
})

/** 公开申请端点: POST /api/auth/apply (挂在 auth 路由 prefix 下) */
export const publicApplyRoute: FastifyPluginAsync = async (app) => {
  app.post('/apply', async (req: any, reply: any) => {
    const parsed = applySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message })
    }
    const d = parsed.data

    const tenant = await prisma.tenant.findUnique({ where: { slug: d.tenantSlug } })
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(404).send({ error: '租户不存在' })
    }

    // 重复检查: 已经是用户 / 有未决申请
    const existingUser = await prisma.user.findUnique({
      where: { tenantId_phone: { tenantId: tenant.id, phone: d.phone } },
    })
    if (existingUser) return reply.status(400).send({ error: '该手机号已注册, 请直接登录' })

    const pending = await prisma.userApplication.findFirst({
      where: { tenantId: tenant.id, phone: d.phone, status: 'PENDING' },
    })
    if (pending) return reply.status(400).send({ error: '该手机号已有待审批的申请' })

    // 供应商: 加入已有公司时校验 supplierId 真存在
    if (d.requestedRole === 'SUPPLIER_STAFF' && d.supplierId) {
      const sup = await prisma.supplier.findFirst({
        where: { id: d.supplierId, tenantId: tenant.id, status: 'ENABLED' },
      })
      if (!sup) return reply.status(400).send({ error: '所选供应商不存在或已停用' })
    }
    // 店长/厨师长: 校验门店真存在
    if (['MANAGER', 'KITCHEN_LEAD'].includes(d.requestedRole) && d.requestedStoreId) {
      const st = await prisma.store.findFirst({ where: { id: d.requestedStoreId, tenantId: tenant.id } })
      if (!st) return reply.status(400).send({ error: '所选门店不存在' })
    }

    const passwordHash = await bcrypt.hash(d.password, 10)
    await prisma.userApplication.create({
      data: {
        tenantId: tenant.id,
        name: d.name, phone: d.phone, passwordHash,
        requestedRole: d.requestedRole as any,
        reason: d.reason || null,
        supplierId:   d.supplierId   || null,
        supplierName: d.supplierName || null,
        requestedStoreId: d.requestedStoreId || null,
      },
    })
    return reply.status(201).send({ ok: true, message: '申请已提交, 等待老板审批' })
  })

  // 公开端点: 列出本租户的可加入供应商 (apply 表单"加入已有公司"用)
  app.get('/supplier-list', async (req: any, reply: any) => {
    const slug = (req.query?.tenantSlug as string) || 'dianjie'
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
  app.get('/store-list', async (req: any, reply: any) => {
    const slug = (req.query?.tenantSlug as string) || 'dianjie'
    const tenant = await prisma.tenant.findUnique({ where: { slug } })
    if (!tenant) return reply.status(404).send({ error: '租户不存在' })
    const list = await prisma.store.findMany({
      where: { tenantId: tenant.id },
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

    const { status } = req.query as any
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

    const appl = await prisma.userApplication.findFirst({
      where: { id: req.params.id, tenantId },
    })
    if (!appl) return reply.status(404).send({ error: '申请不存在' })
    if (appl.status !== 'PENDING') return reply.status(400).send({ error: '该申请已处理' })

    // 老板审批时, 如果没传 storeId, 默认用申请人 申请时填的 requestedStoreId
    if (!parsed.data.storeId && appl.requestedStoreId) {
      parsed.data.storeId = appl.requestedStoreId
    }
    // 店长 / 厨师长 必须有门店
    if (['MANAGER', 'KITCHEN_LEAD'].includes(appl.requestedRole) && !parsed.data.storeId) {
      return reply.status(400).send({ error: `${appl.requestedRole === 'MANAGER' ? '店长' : '厨师长'}角色必须绑定门店` })
    }
    if (parsed.data.storeId) {
      const s = await prisma.store.findFirst({ where: { id: parsed.data.storeId, tenantId } })
      if (!s) return reply.status(400).send({ error: '门店不存在' })
    }

    // 再次确认手机号未被占用 (并发兜底)
    const exists = await prisma.user.findUnique({
      where: { tenantId_phone: { tenantId, phone: appl.phone } },
    })
    if (exists) return reply.status(400).send({ error: '该手机号已注册, 请拒绝该申请' })

    const emailFinal = `${appl.phone}@phone.dianjie`

    // 供应商分支处理: 计算最终的 supplierId
    let finalSupplierId: string | null = null
    let createdSupplierNote = ''
    if (appl.requestedRole === 'SUPPLIER_STAFF') {
      // 加入已有供应商, 校验并使用 appl.supplierId
      if (!appl.supplierId) return reply.status(400).send({ error: '该申请缺少供应商ID, 请拒绝并让其重新申请' })
      const sup = await prisma.supplier.findFirst({ where: { id: appl.supplierId, tenantId } })
      if (!sup) return reply.status(400).send({ error: '所选供应商不存在' })
      finalSupplierId = sup.id
    } else if (appl.requestedRole === 'SUPPLIER_OWNER') {
      // 注册新供应商, 用 appl.supplierName 创建一个 Supplier
      if (!appl.supplierName) return reply.status(400).send({ error: '该申请缺少供应商公司名, 请拒绝并让其重新申请' })
      // 找下一个可用 SUP 编号
      const lastSup = await prisma.supplier.findFirst({
        where: { tenantId, no: { startsWith: 'SUP' } },
        orderBy: { no: 'desc' }, select: { no: true },
      })
      const n = lastSup?.no ? parseInt(lastSup.no.replace(/^SUP/, ''), 10) + 1 : 1
      const newNo = 'SUP' + String(n).padStart(3, '0')
      const newSup = await prisma.supplier.create({
        data: {
          tenantId, no: newNo, name: appl.supplierName,
          contactName: appl.name, contactPhone: appl.phone, status: 'ENABLED',
        },
      })
      finalSupplierId = newSup.id
      createdSupplierNote = ` + 创建供应商 ${newNo} ${appl.supplierName}`
    }

    const [, _appl] = await prisma.$transaction([
      prisma.user.create({
        data: {
          tenantId,
          name: appl.name,
          phone: appl.phone,
          email: emailFinal,
          password: appl.passwordHash,
          role: appl.requestedRole,
          storeId: parsed.data.storeId || null,
          supplierId: finalSupplierId,
          status: 'ACTIVE',
        },
      }),
      prisma.userApplication.update({
        where: { id: appl.id },
        data: {
          status: 'APPROVED',
          decidedById: operatorId,
          decidedAt: new Date(),
        },
      }),
    ])

    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `通过账号申请 ${appl.name} (${appl.phone})${createdSupplierNote}`, entityType: 'UserApplication', targetId: appl.id },
    })
    return { ok: true }
  })

  // POST /api/applications/:id/reject
  app.post('/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!APPROVE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })

    const parsed = rejectSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })

    const appl = await prisma.userApplication.findFirst({
      where: { id: req.params.id, tenantId },
    })
    if (!appl) return reply.status(404).send({ error: '申请不存在' })
    if (appl.status !== 'PENDING') return reply.status(400).send({ error: '该申请已处理' })

    await prisma.userApplication.update({
      where: { id: appl.id },
      data: {
        status: 'REJECTED',
        decidedById: operatorId,
        decidedAt: new Date(),
        rejectReason: parsed.data.reason,
      },
    })
    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `拒绝账号申请 ${appl.name} (${appl.phone}): ${parsed.data.reason}`, entityType: 'UserApplication', targetId: appl.id },
    })
    return { ok: true }
  })
}
