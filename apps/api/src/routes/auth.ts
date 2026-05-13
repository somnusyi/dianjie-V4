import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

// identifier: 手机号 (11 位) 或邮箱; 兼容旧字段 email
const loginSchema = z.object({
  identifier: z.string().trim().optional(),
  email:      z.string().trim().optional(),
  password:   z.string().min(1, '密码不能为空'),
  tenantSlug: z.string().default('dianjie'),
}).refine(d => !!(d.identifier?.length || d.email?.length), {
  message: '请输入手机号或邮箱',
})

const PHONE_RE = /^1[3-9]\d{9}$/

export const authRoutes: FastifyPluginAsync = async (app) => {

  // POST /api/auth/login
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0].message })
    }
    const { identifier, email: emailField, password, tenantSlug } = body.data
    const id = (identifier || emailField || '').trim()

    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(401).send({ error: '租户不存在或已停用' })
    }

    const isPhone = PHONE_RE.test(id)
    const user = isPhone
      ? await prisma.user.findUnique({
          where: { tenantId_phone: { tenantId: tenant.id, phone: id } },
          include: {
            store: { select: { id: true, name: true, no: true } },
            supplier: { select: { id: true, name: true } },
          },
        })
      : await prisma.user.findUnique({
          where: { tenantId_email: { tenantId: tenant.id, email: id } },
          include: {
            store: { select: { id: true, name: true, no: true } },
            supplier: { select: { id: true, name: true } },
          },
        })

    if (!user || user.status !== 'ACTIVE') {
      return reply.status(401).send({ error: '账号不存在或已停用' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return reply.status(401).send({ error: '密码错误' })
    }

    const payload = {
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      storeId: user.storeId,
      supplierId: user.supplierId,
    }

    const token = app.jwt.sign(payload, { expiresIn: '8h' })
    const refreshToken = app.jwt.sign({ userId: user.id, tenantId: tenant.id }, { expiresIn: '7d' })

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    await prisma.opLog.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        role: user.role,
        action: '用户登录',
        ip: request.ip,
      },
    })

    return reply.send({
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        storeId: user.storeId,        // 顶层 storeId, 前端 getUser().storeId 直接可用
        supplierId: user.supplierId,
        store: user.store,
        supplier: user.supplier,
      },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    })
  })

  // GET /api/auth/me
  app.get('/me', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const { userId, tenantId } = request.user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        supplier: { select: { id: true, name: true } },
      },
    })
    if (!user) return { error: '用户不存在' }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      store: user.store,
      supplier: user.supplier,
      tenantId,
    }
  })

  // POST /api/auth/logout
  app.post('/logout', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    await prisma.opLog.create({
      data: {
        tenantId: request.user.tenantId,
        userId: request.user.userId,
        action: '用户登出',
        ip: request.ip,
      },
    })
    return { message: '已退出登录' }
  })
}
