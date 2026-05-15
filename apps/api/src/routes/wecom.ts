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
import { prisma } from '@dianjie/db'
import { exchangeOAuthCode, getUserInfo, sendAppMsg, getContactToken } from '../services/wecom'

export const wecomRoutes: FastifyPluginAsync = async (app) => {

  // ── OAuth 跳转 URL 生成 (前端用) ─────────────────────
  app.get('/oauth/url', async (req: any, reply: any) => {
    const { tenant, redirect } = req.query as any
    if (!tenant) return reply.status(400).send({ error: 'tenant 必填' })
    const t = await prisma.tenant.findUnique({ where: { slug: tenant } })
    if (!t) return reply.status(404).send({ error: 'tenant 不存在' })
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: t.id } })
    if (!cfg || !cfg.enabled) return reply.status(400).send({ error: '该 tenant 未启用企微' })

    const base = process.env.WECOM_REDIRECT_BASE || 'https://www.njdianjie.com'
    const redirectUri = encodeURIComponent(`${base}/api/wecom/oauth/callback`)
    const state = encodeURIComponent(`${tenant}|${redirect || '/'}`)
    // 企微 OAuth 默认走静默授权 (snsapi_base), 仅企业内成员可用
    const url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${cfg.corpId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=${state}&agentid=${cfg.agentId}#wechat_redirect`
    return reply.send({ url })
  })

  // ── OAuth 回调: 用 code 换 user, 自动登录 ─────────────
  app.get('/oauth/callback', async (req: any, reply: any) => {
    const { code, state } = req.query as any
    if (!code) return reply.status(400).send({ error: 'code 必填' })
    const [tenantSlug, redirect] = decodeURIComponent(state || '').split('|')
    const t = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
    if (!t) return reply.status(404).send({ error: 'tenant 不存在' })

    try {
      // 1. code 换 userid
      const { wecomUserId } = await exchangeOAuthCode(t.id, code)
      // 2. 看 wecomUserId 在 User 表里是否已绑定
      let user = await prisma.user.findUnique({ where: { tenantId_wecomUserId: { tenantId: t.id, wecomUserId } } })
      // 3. 没绑定 → 自动按 mobile 匹配现有员工; 都没匹配上则跳「绑定页」
      if (!user) {
        const info = await getUserInfo(t.id, wecomUserId)
        if (info.mobile) {
          user = await prisma.user.findUnique({ where: { tenantId_phone: { tenantId: t.id, phone: info.mobile } } })
          if (user) {
            await prisma.user.update({
              where: { id: user.id },
              data: { wecomUserId, wecomDeptIds: info.deptIds, lastLoginAt: new Date() },
            })
          }
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

      // 4. 签滇界 JWT (复用现有 365d 长会话)
      const token = (app as any).jwt.sign({
        userId: user.id, tenantId: t.id, role: user.role,
        storeId: user.storeId, supplierId: user.supplierId,
      }, { expiresIn: '365d' })

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
      return reply.redirect(`${base}/v2/wecom-bridge#token=${token}&user=${userJson}&tenant=${tenantSlug}&redirect=${encodeURIComponent(redirect || '/')}`)
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
    if (req.user.role !== 'ADMIN') return reply.status(403).send({ error: '仅老板可查看' })
    const cfg = await prisma.weComConfig.findUnique({ where: { tenantId: req.user.tenantId } })
    if (!cfg) return reply.send(null)
    // secret 脱敏返回
    return reply.send({
      corpId: cfg.corpId, agentId: cfg.agentId, enabled: cfg.enabled,
      hasAppSecret: !!cfg.appSecret,
      hasContactSecret: !!cfg.contactSecret,
      callbackToken: cfg.callbackToken, // token 不敏感
    })
  })

  app.put('/config', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    if (req.user.role !== 'ADMIN') return reply.status(403).send({ error: '仅老板可设置' })
    const { corpId, agentId, appSecret, contactSecret, callbackToken, encodingAESKey, enabled } = req.body as any
    if (!corpId || !agentId) return reply.status(400).send({ error: 'corpId / agentId 必填' })
    const cfg = await prisma.weComConfig.upsert({
      where: { tenantId: req.user.tenantId },
      create: {
        tenantId: req.user.tenantId, corpId, agentId,
        appSecret: appSecret || '',
        contactSecret, callbackToken, encodingAESKey,
        enabled: enabled !== false,
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
    return reply.send({ ok: true, id: cfg.id })
  })

  // ── 手动同步通讯录 (按 mobile 自动绑) ────────────────
  app.post('/sync-contacts', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    if (req.user.role !== 'ADMIN') return reply.status(403).send({ error: '仅老板可同步' })
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
  app.post('/test-msg', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const me = await prisma.user.findUnique({ where: { id: req.user.userId } })
    if (!me?.wecomUserId) return reply.status(400).send({ error: '你的账号未绑定企微' })
    const { content } = req.body as any
    await sendAppMsg(req.user.tenantId, me.wecomUserId, content || '滇界云管 · 集成测试消息 ' + new Date().toLocaleString('zh-CN'))
    return reply.send({ ok: true })
  })
}
