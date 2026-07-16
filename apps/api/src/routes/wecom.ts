/**
 * 企微集成 HTTP 路由
 *
 * 公开:
 *   GET  /api/wecom/oauth/url?tenant=dianjie       生成企微 OAuth 跳转 URL
 *   GET  /api/wecom/oauth/callback?code=&state=    OAuth 回调, 自动登录或注册-绑定
 *
 * 鉴权 (仅 ADMIN):
 *   GET  /api/wecom/config                         查看当前 tenant 配置
 *   PUT  /api/wecom/config                         设置 corpId/agentId/secret
 *   POST /api/wecom/sync-contacts                  手动触发通讯录拉取
 *
 * 鉴权 (任意角色):
 *   POST /api/wecom/test-msg                       自测发送应用消息给自己
 */
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { exchangeOAuthCode, getUserInfo, sendAppMsg, getContactToken } from '../services/wecom'
import { issueSessionTokens } from '../services/authTokens'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])
const tenantSlugSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/i, 'tenant 格式不正确')
const safeRedirectSchema = z.string().max(500).refine(
  value => value.startsWith('/') && !value.startsWith('//'),
  'redirect 只允许站内相对路径',
)
const oauthUrlSchema = z.object({
  tenant: tenantSlugSchema,
  redirect: safeRedirectSchema.optional(),
  mode: z.enum(['silent']).optional(),
}).strict()
const oauthCallbackSchema = z.object({
  code: z.string().trim().min(1).max(512),
  state: z.string().min(1).max(1024),
}).strict()
const configSchema = z.object({
  corpId: z.string().trim().min(1, 'corpId 必填').max(64),
  agentId: z.string().trim().regex(/^\d{1,32}$/, 'agentId 必须为数字'),
  appSecret: z.string().max(512).optional(),
  contactSecret: z.union([z.string().max(512), z.null()]).optional(),
  callbackToken: z.union([z.string().max(256), z.null()]).optional(),
  encodingAESKey: z.union([z.string().max(128), z.null()]).optional(),
  enabled: z.boolean().optional(),
}).strict()
const testMessageSchema = z.object({
  content: z.string().trim().min(1).max(1000).optional(),
}).strict()

function firstIssue(parsed: { success: false; error: z.ZodError }) {
  return parsed.error.issues[0]?.message || '请求参数错误'
}

export const wecomRoutes: FastifyPluginAsync = async (app) => {

  // ── OAuth 跳转 URL 生成 (前端用) ─────────────────────
  app.get('/oauth/url', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  } as any, async (req: any, reply: any) => {
    const parsed = oauthUrlSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const { tenant, redirect, mode } = parsed.data
    const t = await prisma.tenant.findUnique({ where: { slug: tenant } })
    if (!t || t.status !== 'ACTIVE') return reply.status(404).send({ error: 'tenant 不存在或已停用' })
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: t.id } })
    if (!cfg || !cfg.enabled) return reply.status(400).send({ error: '该 tenant 未启用企微' })

    const base = process.env.WECOM_REDIRECT_BASE || 'https://www.njdianjie.com'
    const redirectUri = encodeURIComponent(`${base}/api/wecom/oauth/callback`)
    // P2: 防 open redirect; 只允许相对路径
    const safeRedirect = redirect || '/'
    const state = encodeURIComponent(`${tenant}|${safeRedirect}`)
    // 企微登录:
    //   默认 wwlogin — 扫码/拉起一键登录, 在普通浏览器 / 独立 App(套壳) 里点也能拉起企微授权后跳回
    //   ?mode=silent — snsapi_base 静默授权, 仅在企微 App WebView 内有效 (老的企微内登录入口)
    // 两者回调都落 /api/wecom/oauth/callback, 用同一个 auth/getuserinfo 换 userid, 后端无需区分
    const url = mode === 'silent'
      ? `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${cfg.corpId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=${state}&agentid=${cfg.agentId}#wechat_redirect`
      : `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=${cfg.corpId}&agentid=${cfg.agentId}&redirect_uri=${redirectUri}&state=${state}`
    return reply.send({ url })
  })

  // ── OAuth 回调: 用 code 换 user, 自动登录 ─────────────
  app.get('/oauth/callback', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  } as any, async (req: any, reply: any) => {
    const parsed = oauthCallbackSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const { code, state } = parsed.data
    let decodedState: string
    try {
      decodedState = decodeURIComponent(state)
    } catch {
      return reply.status(400).send({ error: 'state 格式不正确' })
    }
    const [tenantSlug, rawRedirect] = decodedState.split('|')
    if (!tenantSlugSchema.safeParse(tenantSlug).success) {
      return reply.status(400).send({ error: 'state 中的 tenant 格式不正确' })
    }
    // P2: 防 open redirect
    const redirect = (rawRedirect && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')) ? rawRedirect : '/'
    const t = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
    if (!t || t.status !== 'ACTIVE') return reply.status(404).send({ error: 'tenant 不存在或已停用' })

    try {
      // 1. code 换 userid
      const { wecomUserId } = await exchangeOAuthCode(t.id, code)
      // 2. 看 wecomUserId 在 User 表里是否已绑定
      let user = await prisma.user.findUnique({ where: { tenantId_wecomUserId: { tenantId: t.id, wecomUserId } } })
      // 3. 没绑定 → 自动匹配现有员工; 都没匹配上则跳「绑定页」
      //    优先按手机号 (企微授权读敏感信息时最可靠); 读不到手机号时退回按姓名
      //    (企微 OAuth 一定返回姓名; 通讯录"敏感信息"权限受限时手机号可能为空)
      if (!user) {
        const info = await getUserInfo(t.id, wecomUserId)
        // 3a. 按手机号匹配
        if (info.mobile) {
          user = await prisma.user.findUnique({ where: { tenantId_phone: { tenantId: t.id, phone: info.mobile } } })
        }
        // 3b. 手机号匹配不到 → 按姓名匹配「未绑定」的同名员工, 须唯一 (多个同名则不自动绑, 避免误绑)
        if (!user && info.name) {
          const byName = await prisma.user.findMany({
            where: { tenantId: t.id, name: info.name, wecomUserId: null },
            take: 2,
          })
          if (byName.length === 1) user = byName[0]
        }
        // 命中 → 写入绑定
        if (user) {
          await prisma.user.update({
            where: { id: user.id },
            data: { wecomUserId, wecomDeptIds: info.deptIds, lastLoginAt: new Date() },
          })
        }
        // 仍没找到 → 提示员工先让管理员加账号
        if (!user) {
          await prisma.weComSyncLog.create({
            data: {
              tenantId: t.id, kind: 'oauth_login', status: 'error',
              payload: { wecomUserId, mobile: info.mobile, name: info.name } as any,
              errorMsg: '企微员工未在滇界登记',
            },
          })
          return reply.redirect(`/v2/login?error=${encodeURIComponent(`企微账号 ${info.name} 还未在滇界登记, 请先联系管理员`)}`)
        }
      } else {
        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      }

      if (user.status !== 'ACTIVE') {
        await prisma.weComSyncLog.create({
          data: {
            tenantId: t.id, kind: 'oauth_login', status: 'error',
            payload: { userId: user.id, wecomUserId } as any,
            errorMsg: '企微绑定账号已停用',
          },
        })
        return reply.redirect(`/v2/login?error=${encodeURIComponent('该滇界账号已停用, 请联系管理员')}`)
      }

      // 4. 与密码登录共用 2h access + 30d refresh，禁止企微产生旧式 365d 旁路令牌。
      const { token, refreshToken } = issueSessionTokens((app as any).jwt, user)

      await prisma.weComSyncLog.create({
        data: {
          tenantId: t.id, kind: 'oauth_login', status: 'ok',
          payload: { userId: user.id, wecomUserId } as any,
        },
      })

      // 5. 把 token 通过 hash 传给前端, 前端 setSession 后跳目标页
      const base = process.env.WECOM_REDIRECT_BASE || 'https://www.njdianjie.com'
      const userJson = encodeURIComponent(JSON.stringify({
        id: user.id, name: user.name, role: user.role, storeId: user.storeId, supplierId: user.supplierId,
      }))
      return reply.redirect(`${base}/v2/wecom-bridge#token=${token}&refreshToken=${refreshToken}&user=${userJson}&tenant=${tenantSlug}&redirect=${encodeURIComponent(redirect || '/')}`)
    } catch (e: any) {
      await prisma.weComSyncLog.create({
        data: {
          tenantId: t.id, kind: 'oauth_login', status: 'error',
          errorMsg: e.message || String(e),
        },
      })
      return reply.redirect(`/v2/login?error=${encodeURIComponent('企微登录失败: ' + (e.message || ''))}`)
    }
  })

  // ── 查看 / 设置配置 (仅 ADMIN) ───────────────────────
  app.get('/config', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    if (!ADMIN_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅老板或超级管理员可查看' })
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } })
    if (!cfg) return reply.send(null)
    // secret 脱敏返回
    return reply.send({
      corpId: cfg.corpId, agentId: cfg.agentId, enabled: cfg.enabled,
      hasAppSecret: !!cfg.appSecret,
      hasContactSecret: !!cfg.contactSecret,
      hasCallbackToken: !!cfg.callbackToken,
      hasEncodingAESKey: !!cfg.encodingAESKey,
    })
  })

  app.put('/config', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    if (!ADMIN_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅老板或超级管理员可设置' })
    const parsed = configSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const { corpId, agentId, appSecret, contactSecret, callbackToken, encodingAESKey, enabled } = parsed.data
    // 审计只记录字段名，不记录任何 Secret / Token 值。
    const changedFields = Object.keys(parsed.data)
    const cfg = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`wecom-config:${req.user.tenantId}`}))::text AS locked`
      const existing = await tx.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } })
      const effectiveEnabled = enabled ?? existing?.enabled ?? true
      const effectiveAppSecret = appSecret ?? existing?.appSecret ?? ''
      if (effectiveEnabled && !effectiveAppSecret) {
        throw { statusCode: 400, message: '启用企微前必须填写 appSecret' }
      }
      const saved = await tx.weComConfig.upsert({
        where: { tenantId: req.user.tenantId },
        create: {
          tenantId: req.user.tenantId, corpId, agentId,
          appSecret: appSecret || '',
          contactSecret, callbackToken, encodingAESKey,
          enabled: effectiveEnabled,
        },
        update: {
          corpId, agentId,
          ...(appSecret !== undefined && { appSecret, accessToken: null, accessTokenExp: null }),
          ...(contactSecret !== undefined && { contactSecret, contactToken: null, contactTokenExp: null }),
          ...(callbackToken !== undefined && { callbackToken }),
          ...(encodingAESKey !== undefined && { encodingAESKey }),
          ...(enabled !== undefined && { enabled }),
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: req.user.tenantId,
          userId: req.user.userId,
          role: req.user.role,
          action: existing ? '更新企微配置' : '创建企微配置',
          targetId: saved.id,
          entityType: 'WeComConfig',
          metadata: { changedFields, enabled: saved.enabled },
        },
      })
      return saved
    })
    return reply.send({ ok: true, id: cfg.id })
  })

  // ── 手动同步通讯录 (按 mobile 自动绑) ────────────────
  app.post('/sync-contacts', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    if (!ADMIN_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅老板或超级管理员可同步' })
    try {
      const token = await getContactToken(req.user.tenantId)
      // 拉取根部门所有人员 (department=1 = 企业根)
      const r: any = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=1&fetch_child=1`)
        .then((r) => r.json())
      if (r.errcode !== 0) throw { statusCode: 500, message: `通讯录拉取失败: ${r.errmsg}` }
      const wecomUsers = r.userlist || []
      let bound = 0, alreadyBound = 0, noMatch = 0
      for (const wu of wecomUsers) {
        if (!wu.mobile) { noMatch++; continue }
        const existing = await prisma.user.findUnique({
          where: { tenantId_phone: { tenantId: req.user.tenantId, phone: wu.mobile } },
        })
        if (!existing) { noMatch++; continue }
        if (existing.wecomUserId === wu.userid) { alreadyBound++; continue }
        await prisma.user.update({
          where: { id: existing.id },
          data: { wecomUserId: wu.userid, wecomDeptIds: wu.department || [] },
        })
        bound++
      }
      await prisma.weComSyncLog.create({
        data: {
          tenantId: req.user.tenantId, kind: 'contact_sync', status: 'ok',
          payload: { total: wecomUsers.length, bound, alreadyBound, noMatch } as any,
        },
      })
      return reply.send({ total: wecomUsers.length, bound, alreadyBound, noMatch })
    } catch (e: any) {
      await prisma.weComSyncLog.create({
        data: { tenantId: req.user.tenantId, kind: 'contact_sync', status: 'error', errorMsg: e.message },
      })
      return reply.status(500).send({ error: e.message })
    }
  })

  // ── 自测发消息给自己 ─────────────────────────────────
  app.post('/test-msg', {
    preHandler: [(app as any).authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  } as any, async (req: any, reply: any) => {
    const parsed = testMessageSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: firstIssue(parsed) })
    const { content } = parsed.data
    const me = await prisma.user.findUnique({ where: { id: req.user.userId } })
    if (!me?.wecomUserId) return reply.status(400).send({ error: '你的账号未绑定企微' })
    await sendAppMsg(req.user.tenantId, me.wecomUserId, content || '滇界云管 · 集成测试消息 ' + new Date().toLocaleString('zh-CN'))
    return reply.send({ ok: true })
  })
}
