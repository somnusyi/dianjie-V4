import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import bcrypt from 'bcryptjs'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: '超管', ADMIN: '管理员', FINANCE: '财务',
  MANAGER: '店长', PURCHASER: '采购', SUPPLIER_STAFF: '供应商',
}

export const userRoutes: FastifyPluginAsync = async (app) => {

  // 获取用户列表
  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN', 'SUPER_ADMIN', 'FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const { storeId, roleFilter, status } = req.query as any
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
    const { tenantId, role, id: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const { name, email, phone, password, role: newRole, storeId } = req.body as any

    if (!name || !password) {
      return reply.status(400).send({ error: '姓名、密码为必填项' })
    }
    if (!phone && !email) {
      return reply.status(400).send({ error: '手机号或邮箱至少填一项' })
    }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return reply.status(400).send({ error: '手机号格式不正确' })
    }
    // 邮箱可选: 没填就生成一个占位 (避免 unique 冲突, schema 上 email 非空)
    const emailFinal = email && email.trim() ? email.trim() : `${phone}@phone.dianjie`

    // 唯一性校验
    if (phone) {
      const phoneExists = await prisma.user.findUnique({
        where: { tenantId_phone: { tenantId, phone } },
      })
      if (phoneExists) return reply.status(400).send({ error: '该手机号已被使用' })
    }
    const emailExists = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: emailFinal } },
    })
    if (emailExists) return reply.status(400).send({ error: '该邮箱已被使用' })

    // 店长必须绑定门店
    if (newRole === 'MANAGER' && !storeId) {
      return reply.status(400).send({ error: '店长角色必须绑定门店' })
    }

    // 校验门店归属
    if (storeId) {
      const store = await prisma.store.findFirst({ where: { id: storeId, tenantId } })
      if (!store) return reply.status(400).send({ error: '门店不存在' })
    }

    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: {
        tenantId, name, email: emailFinal, phone: phone || null,
        password: hashed,
        role: newRole || 'MANAGER',
        storeId: storeId || null,
        status: 'ACTIVE',
      },
      select: { id: true, name: true, email: true, phone: true, role: true, status: true, storeId: true },
    })

    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `创建用户 ${name}（${ROLE_LABEL[newRole] || newRole}）`, entityType: 'User', targetId: user.id },
    })

    return reply.status(201).send(user)
  })

  // 更新用户
  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, id: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } })
    if (!target) return reply.status(404).send({ error: '用户不存在' })

    // 不允许修改超管
    if (target.role === 'SUPER_ADMIN') return reply.status(403).send({ error: '不能修改超管账号' })

    const { name, phone, role: newRole, storeId, password } = req.body as any

    const data: any = {}
    if (name) data.name = name
    if (phone !== undefined) {
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
        return reply.status(400).send({ error: '手机号格式不正确' })
      }
      if (phone) {
        const dup = await prisma.user.findUnique({
          where: { tenantId_phone: { tenantId, phone } },
        })
        if (dup && dup.id !== target.id) {
          return reply.status(400).send({ error: '该手机号已被使用' })
        }
      }
      data.phone = phone || null
    }
    if (newRole) data.role = newRole
    if (storeId !== undefined) data.storeId = storeId || null
    if (password) data.password = await bcrypt.hash(password, 10)

    // 店长必须绑定门店
    const effectiveRole = newRole || target.role
    const effectiveStoreId = storeId !== undefined ? storeId : target.storeId
    if (effectiveRole === 'MANAGER' && !effectiveStoreId) {
      return reply.status(400).send({ error: '店长角色必须绑定门店' })
    }

    await prisma.user.update({ where: { id: target.id }, data })
    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `更新用户 ${target.name}`, entityType: 'User', targetId: target.id },
    })

    return { message: '更新成功' }
  })

  // 禁用/启用用户
  app.patch('/:id/toggle', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, id: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } })
    if (!target) return reply.status(404).send({ error: '用户不存在' })
    if (target.id === operatorId) return reply.status(400).send({ error: '不能禁用自己' })
    if (target.role === 'SUPER_ADMIN') return reply.status(403).send({ error: '不能禁用超管' })

    const newStatus = target.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await prisma.user.update({ where: { id: target.id }, data: { status: newStatus } })

    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `${newStatus === 'ACTIVE' ? '启用' : '禁用'}用户 ${target.name}`, entityType: 'User', targetId: target.id },
    })

    return { message: newStatus === 'ACTIVE' ? '已启用' : '已禁用', status: newStatus }
  })

  // 重置密码
  app.patch('/:id/reset-password', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, id: operatorId } = req.user
    if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }

    const { password } = req.body as any
    if (!password || password.length < 6) {
      return reply.status(400).send({ error: '密码至少6位' })
    }

    const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId } })
    if (!target) return reply.status(404).send({ error: '用户不存在' })

    await prisma.user.update({
      where: { id: target.id },
      data: { password: await bcrypt.hash(password, 10) },
    })

    await prisma.opLog.create({
      data: { tenantId, userId: operatorId, action: `重置用户密码 ${target.name}`, entityType: 'User', targetId: target.id },
    })

    return { message: '密码已重置' }
  })
}
