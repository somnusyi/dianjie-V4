import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'local-auth-test-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 认证完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 认证完整性验证只允许本地服务')
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
  const suffix = String(Date.now()).slice(-9)
  const phone = `16${suffix}`
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '认证完整性测试', phone,
      email: `auth-${suffix}@local.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role: 'FINANCE', status: 'ACTIVE',
    },
  })
  let triggerInstalled = false

  try {
    assert.equal((await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: phone, password: PASSWORD, tenantSlug: TENANT_SLUG, forged: true }),
    })).status, 400)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_auth_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${user.id}' AND NEW.action = '用户登录' THEN
          RAISE EXCEPTION 'forced login audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_auth_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_auth_audit()`)
    triggerInstalled = true
    const failedLogin = await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: phone, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(failedLogin.status, 500, JSON.stringify(failedLogin))
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt, null)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_auth_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_auth_audit()')
    triggerInstalled = false

    const login = await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: phone, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login))
    const auth = { authorization: `Bearer ${login.body.token}` }
    assert.ok(login.body.refreshToken)
    assert.equal((await request('/api/auth/refresh', {
      method: 'POST', body: JSON.stringify({ token: login.body.refreshToken, forged: true }),
    })).status, 400)
    const refreshed = await request('/api/auth/refresh', {
      method: 'POST', body: JSON.stringify({ token: login.body.refreshToken }),
    })
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed))
    assert.ok(refreshed.body.token)
    assert.equal((await request('/api/auth/logout', {
      method: 'POST', headers: auth, body: JSON.stringify({ forged: true }),
    })).status, 400)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_auth_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."userId" = '${user.id}' AND NEW.action = '修改密码' THEN
          RAISE EXCEPTION 'forced password audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_auth_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_auth_audit()`)
    triggerInstalled = true
    const failedChange = await request('/api/auth/change-password', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ oldPassword: PASSWORD, newPassword: `${PASSWORD}-new` }),
    })
    assert.equal(failedChange.status, 500, JSON.stringify(failedChange))
    assert.equal(await bcrypt.compare(PASSWORD, (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password), true)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_auth_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_auth_audit()')
    triggerInstalled = false

    const recovered = await request('/api/auth/change-password', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ oldPassword: PASSWORD, newPassword: `${PASSWORD}-new` }),
    })
    assert.equal(recovered.status, 200, JSON.stringify(recovered))
    const concurrency = await Promise.all([
      request('/api/auth/change-password', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ oldPassword: `${PASSWORD}-new`, newPassword: `${PASSWORD}-a` }),
      }),
      request('/api/auth/change-password', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ oldPassword: `${PASSWORD}-new`, newPassword: `${PASSWORD}-b` }),
      }),
    ])
    assert.equal(concurrency.filter(item => item.status === 200).length, 1, JSON.stringify(concurrency))
    assert.equal(concurrency.filter(item => item.status === 401).length, 1, JSON.stringify(concurrency))
    const finalHash = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).password
    assert.equal(await bcrypt.compare(`${PASSWORD}-a`, finalHash) || await bcrypt.compare(`${PASSWORD}-b`, finalHash), true)
    assert.equal(await prisma.opLog.count({ where: { userId: user.id, action: '修改密码' } }), 2)

    console.log(JSON.stringify({
      ok: true,
      loginAuditAtomic: true,
      strictLoginRefreshLogout: true,
      refreshTenantBound: true,
      passwordAuditAtomicAndSerialized: true,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_auth_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_auth_audit()')
    }
    await prisma.opLog.deleteMany({ where: { userId: user.id } })
    await prisma.revokedToken.deleteMany({ where: { userId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
