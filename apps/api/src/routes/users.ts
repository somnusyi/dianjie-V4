import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import bcrypt from 'bcryptjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: '超管', ADMIN: '管理员', FINANCE: '财务',
  MANAGER: '店长', PURCHASER: '采购', SUPPLIER_STAFF: '供应商',
}

const USER_ROLES = [
  'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'MANAGER', 'PURCHASER', 'SUPPLIER_STAFF',
  'CHEF', 'KITCHEN_LEAD', 'CHEF_DIRECTOR', 'SUPPLIER_OWNER', 'ENGINEERING',
  'SUPERVISOR', 'STAFF',
] as const
const PHONE_RE = /^1[3-9]\d{9}$/
const entityIdSchema = z.string().trim().min(1).max(64)
const nullableEntityIdSchema = z.union([entityIdSchema, z.literal(''), z.null()]).optional()
const nullablePhoneSchema = z.union([z.string().trim().regex(PHONE_RE, '手机号格式不正确'), z.literal(''), z.null()]).optional()

const listQuerySchema = z.object({
  storeId: entityIdSchema.optional(),
  roleFilter: z.enum(USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING_BIND']).optional(),
}).strict()

const createUserSchema = z.object({
  name: z.string().trim().min(1, '姓名必填').max(40),
  email: z.union([z.string().trim().email('邮箱格式不正确').max(120), z.literal('')]).optional(),
  phone: z.union([z.string().trim().regex(PHONE_RE, '手机号格式不正确'), z.literal('')]).optional(),
  password: z.string().min(6, '密码至少 6 位').max(72),
  role: z.enum(USER_ROLES).default('MANAGER'),
  storeId: nullableEntityIdSchema,
  supplierId: nullableEntityIdSchema,
}).strict().refine(data => Boolean(data.phone || data.email), { message: '手机号或邮箱至少填一项' })

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  phone: nullablePhoneSchema,
  role: z.enum(USER_ROLES).optional(),
  storeId: nullableEntityIdSchema,
  supplierId: nullableEntityIdSchema,
  password: z.string().min(6, '密码至少 6 位').max(72).optional(),
}).strict().refine(data => Object.keys(data).length > 0, { message: '没有可更新字段' })

const resetPasswordSchema = z.object({
  password: z.string().min(6, '密码至少 6 位').max(72),
}).strict()

const STORE_BOUND_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'SUPERVISOR'])
const SUPPLIER_BOUND_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF'])

function normalizedId(value: string | null | undefined) {
  return value || null
}

export const userRoutes: FastifyPluginAsync = async (app) => {

  // 获取用户列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { storeId, roleFilter, status } = parsed.data
    const where: any = { tenantId }
    if (storeId) where.storeId = storeId
    if (roleFilter) where.role = roleFilter
    if (status) where.status = status

    return prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, status: true, storeId: true, lastLoginAt: true, createdAt: true,
        store: { select: { id: true, name: true, no: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // 创建用户
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const parsed = createUserSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { name, email, phone, password, role: newRole } = parsed.data
    const storeId = normalizedId(parsed.data.storeId)
    const supplierId = normalizedId(parsed.data.supplierId)
    if (newRole === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: '只有超级管理员可以创建超级管理员' })
    }
    // 邮箱可选: 没填就生成一个占位 (避免 unique 冲突, schema 上 email 非空)
    const emailFinal = email && email.trim() ? email.trim() : `${phone}@phone.dianjie`

    const hashed = await bcrypt.hash(password, 10)
    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-identity:${tenantId}:${phone || emailFinal}`}))::text AS locked`
        if (phone) {
          const existing = await tx.user.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { id: true } })
          if (existing) return { status: 400, error: '该手机号已被使用' }
        }
        const emailExists = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email: emailFinal } }, select: { id: true } })
        if (emailExists) return { status: 400, error: '该邮箱已被使用' }
        if (STORE_BOUND_ROLES.has(newRole) && !storeId) return { status: 400, error: '该角色必须绑定门店' }
        if (SUPPLIER_BOUND_ROLES.has(newRole) && !supplierId) return { status: 400, error: '该角色必须绑定供应商' }
        if (storeId) {
          const store = await tx.store.findFirst({ where: { id: storeId, tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!store) return { status: 400, error: '门店不存在或已停用' }
        }
        if (supplierId) {
          const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!supplier) return { status: 400, error: '供应商不存在或已停用' }
        }
        const user = await tx.user.create({
          data: {
            tenantId, name, email: emailFinal, phone: phone || null, password: hashed,
            role: newRole, storeId, storeIds: storeId ? [storeId] : [], supplierId, status: 'ACTIVE',
          },
          select: { id: true, name: true, email: true, phone: true, role: true, status: true, storeId: true, supplierId: true },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId: operatorId, role,
            action: `创建用户 ${name}（${ROLE_LABEL[newRole] || newRole}）`,
            entityType: 'User', targetId: user.id,
          },
        })
        return { status: 201, user }
      })
      if ('error' in result) return reply.status(result.status).send({ error: result.error })
      return reply.status(201).send(result.user)
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(400).send({ error: '手机号或邮箱已被使用' })
      throw error
    }
  })

  // 更新用户
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '用户标识格式不正确' })
    const parsed = updateUserSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    if (parsed.data.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: '只有超级管理员可以授予超级管理员角色' })
    }
    const hashed = parsed.data.password ? await bcrypt.hash(parsed.data.password, 10) : undefined
    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${idParsed.data}`}))::text AS locked`
        const target = await tx.user.findFirst({ where: { id: idParsed.data, tenantId } })
        if (!target) return { status: 404, error: '用户不存在' }
        if (target.role === 'SUPER_ADMIN') return { status: 403, error: '不能修改超管账号' }

        const phone = parsed.data.phone === undefined ? target.phone : (parsed.data.phone || null)
        const newRole = parsed.data.role || target.role
        const storeId = parsed.data.storeId === undefined ? target.storeId : normalizedId(parsed.data.storeId)
        const supplierId = parsed.data.supplierId === undefined ? target.supplierId : normalizedId(parsed.data.supplierId)
        if (phone) {
          const duplicate = await tx.user.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { id: true } })
          if (duplicate && duplicate.id !== target.id) return { status: 400, error: '该手机号已被使用' }
        }
        if (STORE_BOUND_ROLES.has(newRole) && !storeId) return { status: 400, error: '该角色必须绑定门店' }
        if (SUPPLIER_BOUND_ROLES.has(newRole) && !supplierId) return { status: 400, error: '该角色必须绑定供应商' }
        if (storeId) {
          const store = await tx.store.findFirst({ where: { id: storeId, tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!store) return { status: 400, error: '门店不存在或已停用' }
        }
        if (supplierId) {
          const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId, status: 'ENABLED' }, select: { id: true } })
          if (!supplier) return { status: 400, error: '供应商不存在或已停用' }
        }
        await tx.user.update({
          where: { id: target.id },
          data: {
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.phone !== undefined ? { phone } : {}),
            ...(parsed.data.role !== undefined ? { role: newRole } : {}),
            ...(parsed.data.storeId !== undefined ? { storeId, storeIds: storeId ? [storeId] : [] } : {}),
            ...(parsed.data.supplierId !== undefined ? { supplierId } : {}),
            ...(hashed ? { password: hashed } : {}),
          },
        })
        await tx.opLog.create({
          data: { tenantId, userId: operatorId, role, action: `更新用户 ${target.name}`, entityType: 'User', targetId: target.id },
        })
        return { status: 200, ok: true }
      })
      if ('error' in result) return reply.status(result.status).send({ error: result.error })
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(400).send({ error: '手机号已被使用' })
      throw error
    }
    return { message: '更新成功' }
  })

  // 禁用/启用用户
  app.patch('/:id/toggle', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '用户标识格式不正确' })
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${idParsed.data}`}))::text AS locked`
      const target = await tx.user.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!target) return { status: 404, error: '用户不存在' }
      if (target.id === operatorId) return { status: 400, error: '不能禁用自己' }
      if (target.role === 'SUPER_ADMIN') return { status: 403, error: '不能禁用超管' }
      const newStatus = target.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
      await tx.user.update({ where: { id: target.id }, data: { status: newStatus } })
      await tx.opLog.create({
        data: {
          tenantId, userId: operatorId, role,
          action: `${newStatus === 'ACTIVE' ? '启用' : '禁用'}用户 ${target.name}`,
          entityType: 'User', targetId: target.id,
        },
      })
      return { status: 200, newStatus }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return { message: result.newStatus === 'ACTIVE' ? '已启用' : '已禁用', status: result.newStatus }
  })

  // 重置密码
  app.patch('/:id/reset-password', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const parsed = resetPasswordSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const idParsed = entityIdSchema.safeParse(req.params.id)
    if (!idParsed.success) return reply.status(400).send({ error: '用户标识格式不正确' })
    const password = await bcrypt.hash(parsed.data.password, 10)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${idParsed.data}`}))::text AS locked`
      const target = await tx.user.findFirst({ where: { id: idParsed.data, tenantId } })
      if (!target) return { status: 404, error: '用户不存在' }
      if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
        return { status: 403, error: '无权重置超级管理员密码' }
      }
      await tx.user.update({ where: { id: target.id }, data: { password } })
      await tx.opLog.create({
        data: {
          tenantId, userId: operatorId, role,
          action: `重置用户密码 ${target.name}`, entityType: 'User', targetId: target.id,
        },
      })
      return { status: 200, ok: true }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return { message: '密码已重置' }
  })
}
