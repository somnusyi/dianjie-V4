/**
 * 企微集成服务层
 *
 * 设计原则:
 *   - 企微只做"工具": SSO / 通讯录 / 消息推送, 不当 IM/审批引擎
 *   - 数据闭环在滇界内部, 所有业务操作通过滇界 API, 不经过企微
 *   - access_token 缓存在 DB (WeComConfig.accessToken), 过期 7200s 提前 5min 刷新
 *
 * 暴露:
 *   - getAccessToken(tenantId): 拿应用 access_token (用于消息推送 / OAuth user info)
 *   - getContactToken(tenantId): 拿通讯录同步 access_token (用于人员同步, 区别于应用 token)
 *   - exchangeOAuthCode(tenantId, code): SSO 登录的 code → wecom userId
 *   - getUserInfo(tenantId, wecomUserId): 取人员详情 (name/mobile/email/dept)
 *   - sendAppMsg(tenantId, toUser, content): 给员工发应用消息
 *   - decryptWebhook(tenantId, msgEncrypt, signature, timestamp, nonce): 解密回调消息
 */
import { prisma } from '@dianjie/db'

const WECOM_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'

async function getConfig(tenantId: string) {
  const c = await prisma.weComConfig.findUnique({ where: { tenantId } })
  if (!c || !c.enabled) throw { statusCode: 400, message: '企微集成未启用' }
  return c
}

/**
 * 取应用 access_token (用于 OAuth + 消息推送)
 * 企微限制每天调用次数, 必须缓存
 */
export async function getAccessToken(tenantId: string): Promise<string> {
  const cfg = await getConfig(tenantId)
  // 提前 5 分钟刷新
  if (cfg.accessToken && cfg.accessTokenExp && cfg.accessTokenExp.getTime() > Date.now() + 5 * 60 * 1000) {
    return cfg.accessToken
  }
  const url = `${WECOM_BASE}/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.appSecret}`
  const r = await fetch(url).then((r) => r.json() as any)
  if (r.errcode !== 0) throw { statusCode: 500, message: `企微 token 获取失败: ${r.errmsg}` }
  const expiresAt = new Date(Date.now() + (r.expires_in || 7200) * 1000)
  await prisma.weComConfig.update({
    where: { tenantId },
    data: { accessToken: r.access_token, accessTokenExp: expiresAt },
  })
  return r.access_token
}

/** 取通讯录同步 access_token (用 contactSecret) */
export async function getContactToken(tenantId: string): Promise<string> {
  const cfg = await getConfig(tenantId)
  if (!cfg.contactSecret) throw { statusCode: 400, message: '通讯录同步未配置 contactSecret' }
  if (cfg.contactToken && cfg.contactTokenExp && cfg.contactTokenExp.getTime() > Date.now() + 5 * 60 * 1000) {
    return cfg.contactToken
  }
  const url = `${WECOM_BASE}/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.contactSecret}`
  const r = await fetch(url).then((r) => r.json() as any)
  if (r.errcode !== 0) throw { statusCode: 500, message: `通讯录 token 失败: ${r.errmsg}` }
  const expiresAt = new Date(Date.now() + (r.expires_in || 7200) * 1000)
  await prisma.weComConfig.update({
    where: { tenantId },
    data: { contactToken: r.access_token, contactTokenExp: expiresAt },
  })
  return r.access_token
}

/**
 * OAuth: 用 code 换 user 信息
 * https://developer.work.weixin.qq.com/document/path/91023
 */
export async function exchangeOAuthCode(tenantId: string, code: string): Promise<{ wecomUserId: string; deptIds?: number[] }> {
  const token = await getAccessToken(tenantId)
  const r = await fetch(`${WECOM_BASE}/auth/getuserinfo?access_token=${token}&code=${code}`)
    .then((r) => r.json() as any)
  if (r.errcode !== 0) throw { statusCode: 401, message: `OAuth 失败: ${r.errmsg}` }
  if (!r.userid) throw { statusCode: 401, message: 'OAuth 仅支持企业内成员登录' }
  return { wecomUserId: r.userid }
}

/** 取用户详情 (姓名/手机/邮箱/部门) */
export async function getUserInfo(tenantId: string, wecomUserId: string) {
  const token = await getAccessToken(tenantId)
  const r = await fetch(`${WECOM_BASE}/user/get?access_token=${token}&userid=${encodeURIComponent(wecomUserId)}`)
    .then((r) => r.json() as any)
  if (r.errcode !== 0) throw { statusCode: 500, message: `获取用户信息失败: ${r.errmsg}` }
  return {
    wecomUserId: r.userid,
    name: r.name as string,
    mobile: r.mobile as string | undefined,
    email: r.email as string | undefined,
    deptIds: (r.department || []) as number[],
    avatar: r.avatar as string | undefined,
  }
}

/**
 * 发应用消息 (文本)
 * https://developer.work.weixin.qq.com/document/path/90236
 */
export async function sendAppMsg(tenantId: string, toUser: string | string[], content: string) {
  const cfg = await getConfig(tenantId)
  const token = await getAccessToken(tenantId)
  const body = {
    touser: Array.isArray(toUser) ? toUser.join('|') : toUser,
    msgtype: 'text',
    agentid: parseInt(cfg.agentId),
    text: { content },
    safe: 0,
  }
  const r = await fetch(`${WECOM_BASE}/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as any)
  // 审计日志
  await prisma.weComSyncLog.create({
    data: {
      tenantId, kind: 'send_msg',
      status: r.errcode === 0 ? 'ok' : 'error',
      payload: { toUser, content: content.slice(0, 100), resp: r } as any,
      errorMsg: r.errcode !== 0 ? r.errmsg : null,
    },
  })
  if (r.errcode !== 0) throw { statusCode: 500, message: `消息发送失败: ${r.errmsg}` }
  return r
}

/** 发卡片消息 (跳转滇界 URL); 接受 btnTxt 或 btntxt 两种字段名 */
export async function sendCardMsg(tenantId: string, toUser: string | string[], opts: {
  title: string
  description: string
  url: string
  btnTxt?: string
  btntxt?: string
}) {
  const cfg = await getConfig(tenantId)
  const token = await getAccessToken(tenantId)
  const body = {
    touser: Array.isArray(toUser) ? toUser.join('|') : toUser,
    msgtype: 'textcard',
    agentid: parseInt(cfg.agentId),
    textcard: {
      title: opts.title,
      description: opts.description,
      url: opts.url,
      btntxt: opts.btntxt || opts.btnTxt || '查看详情',
    },
  }
  const r = await fetch(`${WECOM_BASE}/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as any)
  await prisma.weComSyncLog.create({
    data: {
      tenantId, kind: 'send_msg',
      status: r.errcode === 0 ? 'ok' : 'error',
      payload: { toUser, title: opts.title, resp: r } as any,
      errorMsg: r.errcode !== 0 ? r.errmsg : null,
    },
  })
  if (r.errcode !== 0) throw { statusCode: 500, message: `卡片消息失败: ${r.errmsg}` }
  return r
}
