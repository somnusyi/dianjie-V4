/**
 * 服务端拿一次 access_token 验证 secret 正确
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'dianjie' } })
  const cfg = await p.weComConfig.findUnique({ where: { tenantId: t.id } })
  if (!cfg) { console.error('未配置'); process.exit(1) }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpId}&corpsecret=${cfg.appSecret}`
  const r = await fetch(url).then((r) => r.json())
  // 只打印结果状态, 不泄露 token
  console.log({
    errcode: r.errcode,
    errmsg: r.errmsg,
    hasToken: !!r.access_token,
    expiresIn: r.expires_in,
  })
  if (r.errcode === 0) {
    console.log('✓ secret 正确, 可调用企微 API')
    await p.weComConfig.update({
      where: { tenantId: t.id },
      data: { accessToken: r.access_token, accessTokenExp: new Date(Date.now() + r.expires_in * 1000) },
    })
    console.log('✓ access_token 已缓存到 DB')
  } else {
    console.log('✗ secret 错误或 IP 未白名单')
  }
  await p.$disconnect()
})()
