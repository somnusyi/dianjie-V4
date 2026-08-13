// 视觉能力端到端验证: 上传测试图 → 带附件提反馈 → 打印 AI 回复
// 期望: AI 回复能描述图片内容 (红色背景/DIANJIE 字样), 证明图片真的进了模型
const fs = require('fs')
const crypto = require('crypto')

const envPath = '/app/dianjie-v4/apps/api/.env'
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

async function main() {
  const { PrismaClient } = require('@prisma/client')
  const prisma = new PrismaClient()
  const user = await prisma.user.findFirst({ where: { phone: '17328852591' } })
  const { createSigner } = require('fast-jwt')
  const sign = createSigner({ key: process.env.JWT_SECRET, expiresIn: 30 * 60 * 1000 })
  const token = sign({
    userId: user.id, tenantId: user.tenantId, role: user.role,
    storeId: user.storeId || null, supplierId: user.supplierId || null,
    jti: crypto.randomUUID(), typ: 'access', ver: user.authVersion ?? 0,
  })
  const headers = { Authorization: 'Bearer ' + token }

  // 1. 上传测试图到 feedback 目录
  const buf = fs.readFileSync('/tmp/vl_test.png')
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'image/png' }), 'vl_test.png')
  const up = await fetch('http://localhost:4004/api/upload?category=feedback', { method: 'POST', headers, body: form })
  const upBody = await up.json().catch(() => ({}))
  console.log('upload:', up.status, JSON.stringify(upBody).slice(0, 300))
  const url = upBody.url || upBody.fileUrl || (Array.isArray(upBody.urls) && upBody.urls[0])
  if (!url) { console.log('NO_URL'); await prisma.$disconnect(); return }

  // 2. 带附件创建反馈: 文字故意不描述图片内容, 看 AI 是否真能看图
  const fb = await fetch('http://localhost:4004/api/feedback', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '你看下我发的这张图，图里写了什么字？底色是什么颜色？直接回答我',
      context: { path: '/v2/boss', clientTime: '2026-07-28 11:00' },
      attachments: [url],
    }),
  })
  const fbBody = await fb.json().catch(() => ({}))
  console.log('feedback:', fb.status)
  console.log('AI_REPLY:', fbBody.reply)
  console.log('FEEDBACK_ID:', fbBody.id)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
