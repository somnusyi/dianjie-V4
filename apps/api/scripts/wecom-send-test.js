/**
 * 给指定 wecomUserId 发一条测试消息, 验证企微 API + agentId/secret 配置正确
 * 用法: node wecom-send-test.js <userid> [text]
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const [, , userid, ...textParts] = process.argv
if (!userid) { console.error('用法: node wecom-send-test.js <userid> [text]'); process.exit(1) }
const content = textParts.join(' ') || `滇界云管 · 集成测试 ${new Date().toLocaleString('zh-CN')}`

;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'dianjie' } })
  const cfg = await p.weComConfig.findUnique({ where: { tenantId: t.id } })
  let token = cfg.accessToken
  if (!token || !cfg.accessTokenExp || cfg.accessTokenExp.getTime() < Date.now() + 60_000) {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.appSecret}`).then(r => r.json())
    if (r.errcode !== 0) { console.error('gettoken 失败:', r.errmsg); process.exit(1) }
    token = r.access_token
    await p.weComConfig.update({
      where: { tenantId: t.id },
      data: { accessToken: token, accessTokenExp: new Date(Date.now() + r.expires_in * 1000) },
    })
  }
  // 发文本
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: userid,
      msgtype: 'text',
      agentid: parseInt(cfg.agentId),
      text: { content },
    }),
  }).then(r => r.json())
  console.log('text 结果:', JSON.stringify(r))
  // 同时发卡片
  const r2 = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: userid,
      msgtype: 'textcard',
      agentid: parseInt(cfg.agentId),
      textcard: {
        title: '⚠ 报损待处理 LC202605000001',
        description: '合肥瑶海店 报损 ¥978。羊肚菌损1 / 云南腊火腿损10。24h 未处理将自动同意。',
        url: 'https://www.njdianjie.com/v2/supplier/orders/xxx',
        btntxt: '查看证据',
      },
    }),
  }).then(r => r.json())
  console.log('textcard 结果:', JSON.stringify(r2))
  await p.$disconnect()
})()
