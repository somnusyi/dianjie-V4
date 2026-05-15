/**
 * 列出企微应用可见的所有员工 (用应用 access_token, 不需要 contactSecret)
 * 用于人工识别 userid 并临时绑定
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'dianjie' } })
  const cfg = await p.weComConfig.findUnique({ where: { tenantId: t.id } })
  if (!cfg) { console.error('未配置'); process.exit(1) }

  // 重新签 access_token (如果过期)
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

  // list_id 拉所有可见 userid
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/list_id?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100 }),
  }).then(r => r.json())
  if (r.errcode !== 0) { console.error('list_id 失败:', r.errmsg, r.errcode); process.exit(1) }
  const list = r.dept_user || []
  console.log(`应用可见员工数: ${list.length}\n`)

  // 拉每个员工的详情 (姓名 / 手机)
  const names = []
  for (const item of list) {
    try {
      const u = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${encodeURIComponent(item.userid)}`).then(r => r.json())
      if (u.errcode === 0) {
        names.push({ userid: u.userid, name: u.name, mobile: u.mobile || '', dept: u.department, position: u.position || '' })
      }
    } catch (e) { /* skip */ }
  }
  console.log('userid | 姓名 | 手机 | 部门 | 职位')
  console.log('─'.repeat(80))
  for (const n of names) {
    console.log(`${n.userid.padEnd(20)} | ${n.name.padEnd(8)} | ${n.mobile.padEnd(11)} | ${JSON.stringify(n.dept)} | ${n.position}`)
  }
  await p.$disconnect()
})()
