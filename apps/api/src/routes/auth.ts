import { nextBrowserSessionOrder, browserSessionClock } from '../services/browserSessionOrder'
import { revokeSession } from '../lib/revoke-session'
import { isSupplierRole } from '../lib/auth-scope'
import { isBrowserSession, checkBrowserSession, readBrowserRefresh, writeBrowserRefresh } from '../lib/browser-session'
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { loginRateLimitConfig } from '../lib/login-rate-key'
import { prisma } from '@dianjie/db'
import { resolveLoginTenantSlug } from '../lib/preview-tenant'
import { ACCESS_TTL_MS, REFRESH_TTL_MS, issueAccessToken, issueSessionTokens } from '../services/authTokens'

// ── JWT 寿命 ─────────────────────────────────────────────
// access 短 (2h): API 请求带这个, 不查 DB; 过期就靠 refresh 续
// refresh 长 (30d): 只在 /api/auth/refresh 用; 入 RevokedToken 表撤销
// 老 365d 设计已废, 见 docs/cmb/CMB_ERROR_CODES.md (不, 这里是说 auth.ts git 历史)
// identifier: 手机号 (11 位) 或邮箱; 兼容旧字段 email
const tenantSlugSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/i, '租户标识格式不正确')
const loginSchema = z.object({
  identifier: z.string().trim().max(120).optional(),
  email:      z.string().trim().max(120).optional(),
  password:   z.string().min(1, '密码不能为空').max(72),
  tenantSlug: tenantSlugSchema.default('dianjie'),
}).strict().refine(d => !!(d.identifier?.length || d.email?.length), {
  message: '请输入手机号或邮箱',
})

const refreshSchema = z.object({ token: z.string().min(1).max(4096) }).strict()
const logoutSchema = z.object({ refreshToken: z.string().max(4096).optional() }).strict()
const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(72),
  newPassword: z.string().min(6, '新密码至少 6 位').max(72),
}).strict().refine(data => data.oldPassword !== data.newPassword, { message: '新密码不能与原密码相同' })

const PHONE_RE = /^1[3-9]\d{9}$/

// 多店门店列表：按 storeIds 顺序回 id/name/no，供前端门店切换器渲染；空集合回退单店 store
async function loadScopeStores(user: { storeId: string | null; storeIds: string[] }) {
  const ids = user.storeIds?.length ? user.storeIds : (user.storeId ? [user.storeId] : [])
  if (ids.length === 0) return []
  const rows = await prisma.store.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, no: true },
  })
  const rank = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (_request, reply, payload) => {reply.header('cache-control','no-store');return payload})

  // POST /api/auth/login — 门店共用代理，按账号限流，避免一家重试挡住其他门店。
  app.post('/login', {
    config: { rateLimit: loginRateLimitConfig() },
  } as any, async (request, reply) => {
    const browser = isBrowserSession(request)
    if (browser) checkBrowserSession(request)
    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0].message })
    }
    const browserOrder = browser ? await nextBrowserSessionOrder() : undefined
    const { identifier, email: emailField, password, tenantSlug } = body.data
    const id = (identifier || emailField || '').trim()

    const previewTenant = process.env.PREVIEW_TENANT_SLUG?.trim()
    const resolvedTenantSlug = resolveLoginTenantSlug(tenantSlug, previewTenant)
    if (!resolvedTenantSlug) {
      return reply.status(403).send({ error: `本地预览仅允许 ${previewTenant} 测试租户` })
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug: resolvedTenantSlug } })
    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(401).send({ error: '租户不存在或已停用' })
    }

    const isPhone = PHONE_RE.test(id)
    const user = isPhone
      ? await prisma.user.findUnique({
          where: { tenantId_phone: { tenantId: tenant.id, phone: id } },
          include: {
            store: { select: { id: true, name: true, no: true } },
            supplier: { select: { id: true, name: true, businessScopes: true, status:true, tenantId:true } },
          },
        })
      : await prisma.user.findUnique({
          where: { tenantId_email: { tenantId: tenant.id, email: id } },
          include: {
            store: { select: { id: true, name: true, no: true } },
            supplier: { select: { id: true, name: true, businessScopes: true, status:true, tenantId:true } },
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
    const { token, refreshToken, expiresInMs } = issueSessionTokens(app.jwt, user, browserOrder?.order, browserOrder?.issuedAtMs)

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      prisma.opLog.create({
        data: {
          tenantId: tenant.id, userId: user.id, role: user.role,
          action: '用户登录', ip: request.ip,
        },
      }),
    ])

    if (browser) {
      const now = await browserSessionClock()
      writeBrowserRefresh(request, reply, String(request.headers.origin), refreshToken, app.jwt, Math.max(0, Math.floor((browserOrder!.issuedAtMs + REFRESH_TTL_MS - now.issuedAtMs) / 1000)))
    }
    return reply.send({
      token,
      ...(!browser ? { refreshToken } : {}),
      expiresInMs,            // 客户端可用于排程主动 refresh
      user: {
        id: user.id,
        tenantId: user.tenantId,
        name: user.name,
        email: user.email,
        role: user.role,
        storeId: user.storeId,
        storeIds: user.storeIds,
        stores: await loadScopeStores(user),
        supplierId: user.supplierId,
        store: user.store,
        supplier: user.supplier,
      },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    })
  })

  // POST /api/auth/refresh — 用 refresh token 换新 access
  app.post('/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const browser = isBrowserSession(request)
    const cookieRefresh = browser ? readBrowserRefresh(request, app.jwt) : null
    const parsed = refreshSchema.safeParse(cookieRefresh ? { token: cookieRefresh } : request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const rt = parsed.data.token

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

    const user = await prisma.user.findFirst({
      where: { id: decoded.userId, tenantId: decoded.tenantId },
      include: {
        store:    { select: { id: true, name: true, no: true } },
        supplier: { select: { id: true, name: true, businessScopes: true, status:true, tenantId:true } },
        tenant: { select: { status: true } },
      },
    })
    const tokenVersion = typeof decoded.ver === 'number' ? decoded.ver : 0
    if(decoded.sid&&decoded.sid!==decoded.jti&&await prisma.revokedToken.findUnique({where:{jti:decoded.sid}}))return reply.status(401).send({error:'会话已退出，请重新登录'})
    if(user&&isSupplierRole(user.role)&&(!user.supplierId||user.supplier?.status!=='ENABLED'||user.supplier?.tenantId!==user.tenantId||(decoded.supplierId!==undefined&&decoded.supplierId!==user.supplierId)))return reply.status(401).send({error:'供应商账号绑定已变更，请重新登录'})
    if (!user || user.status !== 'ACTIVE' || user.tenant.status !== 'ACTIVE' || user.authVersion !== tokenVersion) {
      return reply.status(401).send({ error: '用户不存在或已停用' })
    }

    const browserClock = browser ? await browserSessionClock() : null
    if (browserClock && (decoded.exp * 1000 <= browserClock.issuedAtMs || (!decoded.bso && decoded.exp * 1000 > browserClock.legacyExpiresAtMs && browserClock.legacyExpiresAtMs <= browserClock.issuedAtMs)))
      return reply.status(401).send({ error: '浏览器会话已过期，请重新登录' })
    const token = issueAccessToken(app.jwt, user, decoded.sid || decoded.jti)
    if (browser && browserClock) {
      const legacy = !decoded.bso || decoded.bso === '0'
      const exp = Math.min(decoded.exp, legacy ? Math.floor(browserClock.legacyExpiresAtMs / 1000) : decoded.exp)
      if (exp * 1000 <= browserClock.issuedAtMs) return reply.status(401).send({ error: '浏览器会话已过期，请重新登录' })
      // A legacy upgrade retains its sid and original expiry, capped at the deployment transition window.
      const migrated = legacy ? app.jwt.sign({ ...decoded, sid: decoded.sid || decoded.jti, bso: '0', exp }, {}) : rt
      writeBrowserRefresh(request, reply, String(request.headers.origin), migrated, app.jwt, Math.max(0, exp - Math.floor(browserClock.issuedAtMs / 1000)))
    }

    // refresh 不轮换 (保持原 30d window), 简化客户端实现; 如要轮换在此颁新 refresh
    return reply.send({
      token,
      expiresInMs: ACCESS_TTL_MS,
      user: {
        id: user.id, tenantId: user.tenantId, name: user.name, email: user.email, role: user.role,
        storeId: user.storeId, storeIds: user.storeIds,
        stores: await loadScopeStores(user),
        supplierId: user.supplierId,
        store: user.store, supplier: user.supplier,
      },
    })
  })

  // Cookie-only logout remains usable after page reload or access expiry.
  app.post('/browser-logout', async (request, reply) => {
    if (!isBrowserSession(request)) return reply.status(403).send({error:'浏览器会话校验失败'})
    const rt = readBrowserRefresh(request, app.jwt)
    await revokeSession(prisma, app.jwt, {refreshToken:rt,ip:request.ip})
    // Do not clear a shared cookie name: a delayed response must not erase a newer login.
    // The selected sid is revoked above; its remaining HttpOnly cookie cannot refresh.
    return {message:'已退出登录'}
  })

  // GET /api/auth/me
  app.get('/me', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const { userId, tenantId } = request.user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        supplier: { select: { id: true, name: true, businessScopes: true, status:true, tenantId:true } },
      },
    })
    if (!user) return { error: '用户不存在' }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
      storeIds: user.storeIds,
      stores: await loadScopeStores(user),
      store: user.store,
      supplier: user.supplier,
      tenantId,
    }
  })

  // POST /api/auth/logout — 撤销 refresh token (核心), 顺便记一笔 access
  app.post('/logout', { preHandler: [(app as any).authenticate] }, async (request: any, reply) => {
    const { userId, tenantId, jti: accessJti } = request.user
    const browser = isBrowserSession(request)
    const cookieRefresh = browser ? readBrowserRefresh(request, app.jwt) : null
    const parsed = logoutSchema.safeParse(cookieRefresh ? { refreshToken: cookieRefresh } : request.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const rt = parsed.data.refreshToken

    await revokeSession(prisma,app.jwt,{refreshToken:rt,accessClaims:request.user,ip:request.ip})
    // Session revocation is sufficient; never let delayed logout clear a newer sid cookie.
    return { message: '已退出登录' }
  })

  // POST /api/auth/change-password — 登录用户自助修改密码 (供应商等所有角色通用)
  app.post('/change-password', {
    preHandler: [(app as any).authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request: any, reply) => {
    const { userId, tenantId } = request.user
    const parsed = changePasswordSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const hashed = await bcrypt.hash(parsed.data.newPassword, 10)
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-password:${userId}`}))::text AS locked`
      const user = await tx.user.findFirst({ where: { id: userId, tenantId, status: 'ACTIVE' } })
      if (!user) return { status: 404, error: '用户不存在或已停用' }
      if (!await bcrypt.compare(parsed.data.oldPassword, user.password)) {
        return { status: 401, error: '原密码错误' }
      }
      await tx.user.update({
        where: { id: user.id },
        data: { password: hashed, authVersion: { increment: 1 } },
      })
      await tx.opLog.create({
        data: { tenantId, userId, role: user.role, action: '修改密码', ip: request.ip },
      })
      return { status: 200, ok: true }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return reply.send({ success: true, message: '密码已修改, 下次登录请用新密码' })
  })
}
