/**
 * 一次性写入 dianjie tenant 的企微配置
 * 用法: node scripts/setup-wecom.js <CorpId> <AgentId> <Secret>
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const [, , corpId, agentId, appSecret] = process.argv
if (!corpId || !agentId || !appSecret) {
  console.error('用法: node setup-wecom.js <CorpId> <AgentId> <Secret>')
  process.exit(1)
}

;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'dianjie' } })
  if (!t) throw new Error('未找到 dianjie tenant')
  const cfg = await p.weComConfig.upsert({
    where: { tenantId: t.id },
    create: {
      tenantId: t.id, corpId, agentId, appSecret,
      enabled: true,
    },
    update: {
      corpId, agentId, appSecret,
      accessToken: null, accessTokenExp: null,
      enabled: true,
    },
  })
  console.log(`✓ tenant=dianjie config saved: corpId=${cfg.corpId} agentId=${cfg.agentId} enabled=${cfg.enabled}`)
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
