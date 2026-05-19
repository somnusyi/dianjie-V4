import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { prisma } from '@dianjie/db'

// ── JWT 寿命 ─────────────────────────────────────────────
// access 短 (2h): API 请求带这个, 不查 DB; 过期就靠 refresh 续
// refresh 长 (30d): 只在 /api/auth/refresh 用; 入 RevokedToken 表撤销
// 老 365d 设计已废, 见 docs/cmb/CMB_ERROR_CODES.md (不, 这里是说 auth.ts git 历史)
const ACCESS_TTL    = '2h'
const REFRESH_TTL   = '30d'
const ACCESS_TTL_MS = 2 * 60 * 60 * 1000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

  // POST /api/auth/login — 单独限流防密码爆破 (10 次/分钟/IP, 同事 c2a4470 引入, 保留)
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } } as any, async (request, reply) => {
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

    // access + refresh 各分配独立 jti, 撤销表按 jti 索引
    const accessJti  = crypto.randomUUID()
    const refreshJti = crypto.randomUUID()

    const accessPayload = {
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      storeId: user.storeId,
      supplierId: user.supplierId,
      jti: accessJti,
      typ: 'access',
    }
    const refreshPayload = {
      userId: user.id,
      tenantId: tenant.id,
      jti: refreshJti,
      typ: 'refresh',
    }

    const token        = app.jwt.sign(accessPayload,  { expiresIn: ACCESS_TTL })
    const refreshToken = app.jwt.sign(refreshPayload, { expiresIn: REFRESH_TTL })

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
      expiresInMs: ACCESS_TTL_MS,            // 客户端可用于排程主动 refresh
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        storeId: user.storeId,
        supplierId: user.supplierId,
        store: user.store,
        supplier: user.supplier,
      },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    })
  })

  // POST /api/auth/refresh — 用 refresh token 换新 access
  app.post('/refresh', async (request, reply) => {
    const { token: rt } = (request.body || {}) as any
    if (!rt) return reply.status(400).send({ error: '缺 refresh token' })

    let decoded: any
    try {
      decoded = app.jwt.verify(rt) as any
    } catch {
      return reply.status(401).send({ error: 'refresh token 无效或已过期' })
    }
    if (decoded?.typ !== 'refresh' || !decoded?.jti || !decoded?.userId) {
      return reply.status(401).send({ error: 'token 类型错误' })
    }

    // 撤销表命中即拒. 不吞错: DB 异常时让 5xx 上抛, 不能 silent allow 让 token 通过
    const revoked = await prisma.revokedToken.findUnique({
      where: { jti: decoded.jti },
    })
    if (revoked) return reply.status(401).send({ error: 'refresh token 已撤销, 请重新登录' })

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        store:    { select: { id: true, name: true, no: true } },
        supplier: { select: { id: true, name: true } },
      },
    })
    if (!user || user.status !== 'ACTIVE') {
      return reply.status(401).send({ error: '用户不存在或已停用' })
    }

    const accessJti = crypto.randomUUID()
    const accessPayload = {
      userId:     user.id,
      tenantId:   decoded.tenantId,
      role:       user.role,
      storeId:    user.storeId,
      supplierId: user.supplierId,
      jti:        accessJti,
      typ:        'access',
    }
    const token = app.jwt.sign(accessPayload, { expiresIn: ACCESS_TTL })

    // refresh 不轮换 (保持原 30d window), 简化客户端实现; 如要轮换在此颁新 refresh
    return reply.send({
      token,
      expiresInMs: ACCESS_TTL_MS,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        storeId: user.storeId, supplierId: user.supplierId,
        store: user.store, supplier: user.supplier,
      },
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

  // POST /api/auth/logout — 撤销 refresh token (核心), 顺便记一笔 access
  app.post('/logout', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const { userId, tenantId, jti: accessJti } = request.user
    const { refreshToken: rt } = (request.body || {}) as any

    // 撤销 access (虽 2h 自然失效, 记录便于审计 + 异常追溯).
    // access 撤销是 audit-only, 不影响业务流程 → 这里吞错保住 logout 主路径成功
    if (accessJti) {
      await prisma.revokedToken.upsert({
        where: { jti: accessJti },
        create: {
          jti: accessJti, userId, tokenType: 'access',
          expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
          reason: 'logout',
        },
        update: {},
      }).catch(() => {})
    }

    // 撤销 refresh (这是关键: 让换 access 链断掉)
    if (rt) {
      try {
        const dec: any = app.jwt.verify(rt)
        if (dec?.typ === 'refresh' && dec?.jti && dec?.userId === userId) {
          await prisma.revokedToken.upsert({
            where: { jti: dec.jti },
            create: {
              jti: dec.jti, userId, tokenType: 'refresh',
              expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
              reason: 'logout',
            },
            update: {},
          })
        }
      } catch { /* 客户端给的 refresh 已坏不影响 logout 主流程 */ }
    }

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: '用户登出',
        ip: request.ip,
      },
    })
    return { message: '已退出登录' }
  })
}
