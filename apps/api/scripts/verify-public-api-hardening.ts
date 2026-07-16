import 'dotenv/config'
import assert from 'node:assert/strict'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 公开 API 验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 公开 API 验证只允许本地服务')
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function main() {
  assertLocalOnly()
  const suffix = String(Date.now()).slice(-8)
  const phone = `18${suffix.slice(-9).padStart(9, '0')}`
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const payload = {
    name: '公开申请并发验证', phone, password: 'local-only-123',
    requestedRole: 'FINANCE', reason: '仅本地安全验证', tenantSlug: TENANT_SLUG,
  }

  try {
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => request('/api/auth/apply', {
      method: 'POST', body: JSON.stringify(index === 4 ? { ...payload, forged: true } : payload),
    })))
    assert.equal(concurrent.filter(item => item.status === 201).length, 1, JSON.stringify(concurrent))
    assert.equal(concurrent.filter(item => item.status === 400).length, 4, JSON.stringify(concurrent))
    assert.equal(await prisma.userApplication.count({
      where: { tenantId: tenant.id, phone, status: 'PENDING' },
    }), 1, '同租户手机号并发申请必须只有一条待审批记录')
    assert.equal((await request('/api/auth/apply', {
      method: 'POST', body: JSON.stringify({ ...payload, phone: `17${phone.slice(2)}` }),
    })).status, 429, '第六次匿名申请必须被小时级限流')

    assert.equal((await request('/api/auth/supplier-list?tenantSlug=bad%20slug')).status, 400)
    assert.equal((await request(`/api/auth/store-list?tenantSlug=${TENANT_SLUG}&extra=1`)).status, 400)
    assert.equal((await request('/api/ops/updater-error', {
      method: 'POST', body: JSON.stringify({ arbitrary: { secret: 'must-not-log' } }),
    })).status, 400, '匿名错误上报不得接受任意对象')
    assert.equal((await request('/api/ops/updater-error', {
      method: 'POST', body: JSON.stringify({ message: '本地更新器验证', platform: 'local', version: '0.0-test' }),
    })).status, 204)

    console.log(JSON.stringify({
      ok: true,
      concurrentApplicationSinglePending: true,
      anonymousApplyRateLimited: true,
      publicQueriesStrict: true,
      updaterLogsWhitelisted: true,
    }))
  } finally {
    await prisma.userApplication.deleteMany({ where: { tenantId: tenant.id, phone } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
