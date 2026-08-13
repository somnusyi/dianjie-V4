// 把视觉联调测试反馈标记为已解决(闭环)
const fs = require('fs')
const crypto = require('crypto')
for (const line of fs.readFileSync('/app/dianjie-v4/apps/api/.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
async function main() {
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  const id = 'cms42f9fg0003wwylg40pasje'
  const user = await prisma.user.findFirst({ where: { phone: '17328852591' } })
  const { createSigner } = require('fast-jwt')
  const sign = createSigner({ key: process.env.JWT_SECRET, expiresIn: 15 * 60 * 1000 })
  const token = sign({
    userId: user.id, tenantId: user.tenantId, role: user.role,
    storeId: user.storeId || null, supplierId: user.supplierId || null,
    jti: crypto.randomUUID(), typ: 'access', ver: user.authVersion ?? 0,
  })
  const res = await fetch(`http://localhost:4004/api/feedback/${id}/resolve`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'AI视觉能力联调测试，已验证通过' }),
  })
  console.log('resolve:', res.status, JSON.stringify(await res.json()).slice(0, 300))
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
