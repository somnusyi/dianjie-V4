// 模拟真实用户：铸造 JWT → HTTP 提交反馈（全链路鉴权+Qwen 澄清）
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { createSigner } from 'fast-jwt'
import crypto from 'node:crypto'

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'dianjie' } })
  const user = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, phone: '18552643101', status: 'ACTIVE' },
    select: { id: true, role: true, storeId: true, authVersion: true, name: true },
  })
  const sign = createSigner({ key: process.env.JWT_SECRET!, expiresIn: 15 * 60 * 1000 })
  const token = sign({
    userId: user.id, tenantId: tenant.id, role: user.role, storeId: user.storeId,
    supplierId: null, jti: crypto.randomUUID(), typ: 'access', ver: user.authVersion ?? 0,
  })
  console.log(`提报人: ${user.name} (${user.role})`)

  const res = await fetch('http://localhost:4004/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      content: '个人中心里面点「我的反馈」打不开，直接跳到 404 页面了，你们快看看怎么回事',
      context: { path: '/v2/me', role: user.role, storeName: '瑶海万达店', userAgent: 'smoke-e2e', clientTime: new Date().toISOString() },
    }),
  })
  const data: any = await res.json()
  console.log(`HTTP ${res.status}`)
  console.log(JSON.stringify(data).slice(0, 900))
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
