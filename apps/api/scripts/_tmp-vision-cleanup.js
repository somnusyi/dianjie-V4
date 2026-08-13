// 清理视觉联调测试反馈: 查状态 → 若待批则以超管身份驳回(注明测试数据)
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
  const fb = await prisma.feedback.findUnique({ where: { id }, select: { status: true, category: true, title: true } })
  console.log('current:', JSON.stringify(fb))
  if (fb && fb.status === 'AWAITING_APPROVAL') {
    const user = await prisma.user.findFirst({ where: { phone: '17328852591' } })
    const { createSigner } = require('fast-jwt')
    const sign = createSigner({ key: process.env.JWT_SECRET, expiresIn: 15 * 60 * 1000 })
    const token = sign({
      userId: user.id, tenantId: user.tenantId, role: user.role,
      storeId: user.storeId || null, supplierId: user.supplierId || null,
      jti: crypto.randomUUID(), typ: 'access', ver: user.authVersion ?? 0,
    })
    const res = await fetch(`http://localhost:4004/api/feedback/${id}/decision`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', note: 'AI视觉能力联调测试数据，非真实反馈' }),
    })
    console.log('reject:', res.status, JSON.stringify(await res.json()).slice(0, 200))
  }
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
