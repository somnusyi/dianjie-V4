import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'local-wecom-boundary-test-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 企微边界验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 企微边界验证只允许本地服务')
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    redirect: 'manual',
  })
  const text = await response.text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { body = { text } }
  return { status: response.status, body, location: response.headers.get('location') }
}

async function main() {
  assertLocalOnly()
  const suffix = String(Date.now()).slice(-9)
  const phones = ['16', '17', '18'].map(prefix => `${prefix}${suffix}`)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const originalConfig = await prisma.weComConfig.findUnique({ where: { tenantId: tenant.id } })
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const [admin, superAdmin, manager] = await prisma.$transaction([
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '企微边界管理员', phone: phones[0],
      email: `wecom-admin-${suffix}@local.invalid`, password: passwordHash,
      role: 'ADMIN', status: 'ACTIVE',
    } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '企微边界超管', phone: phones[1],
      email: `wecom-super-${suffix}@local.invalid`, password: passwordHash,
      role: 'SUPER_ADMIN', status: 'ACTIVE',
    } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '企微边界店长', phone: phones[2],
      email: `wecom-manager-${suffix}@local.invalid`, password: passwordHash,
      role: 'MANAGER', status: 'ACTIVE',
    } }),
  ])
  const userIds = [admin.id, superAdmin.id, manager.id]
  let triggerInstalled = false

  try {
    const invalidRedirect = await request(`/api/wecom/oauth/url?tenant=${TENANT_SLUG}&redirect=${encodeURIComponent('https://evil.invalid')}`)
    assert.equal(invalidRedirect.status, 400, JSON.stringify(invalidRedirect))
    assert.equal((await request(`/api/wecom/oauth/url?tenant=${TENANT_SLUG}&forged=1`)).status, 400)
    assert.equal((await request(`/api/wecom/oauth/callback?code=x&state=%25`)).status, 400)

    const logins = await Promise.all(phones.map(identifier => request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })))
    for (const login of logins) assert.equal(login.status, 200, JSON.stringify(login))
    const [adminAuth, superAuth, managerAuth] = logins.map(login => ({ authorization: `Bearer ${login.body.token}` }))

    assert.equal((await request('/api/wecom/config', { headers: managerAuth })).status, 403)
    assert.equal((await request('/api/wecom/config', { headers: superAuth })).status, 200)
    assert.equal((await request('/api/wecom/config', { headers: adminAuth })).status, 200)
    assert.equal((await request('/api/wecom/config', {
      method: 'PUT', headers: adminAuth,
      body: JSON.stringify({ corpId: 'corp', agentId: 'not-a-number', forged: true }),
    })).status, 400)
    assert.equal((await request('/api/wecom/test-msg', {
      method: 'POST', headers: adminAuth, body: JSON.stringify({ forged: true }),
    })).status, 400)

    const marker = `local-boundary-${suffix}`
    const updateBody = originalConfig
      ? { corpId: originalConfig.corpId, agentId: originalConfig.agentId, callbackToken: marker, enabled: originalConfig.enabled }
      : { corpId: `ww-local-${suffix}`, agentId: '1000001', callbackToken: marker, enabled: false }
    const saved = await request('/api/wecom/config', {
      method: 'PUT', headers: adminAuth, body: JSON.stringify(updateBody),
    })
    assert.equal(saved.status, 200, JSON.stringify(saved))
    const redacted = await request('/api/wecom/config', { headers: adminAuth })
    assert.equal(redacted.status, 200)
    assert.equal(redacted.body.hasCallbackToken, true)
    assert.equal('callbackToken' in redacted.body, false)
    assert.equal(JSON.stringify(redacted.body).includes(marker), false)
    const audit = await prisma.opLog.findFirstOrThrow({
      where: { tenantId: tenant.id, userId: admin.id, targetId: saved.body.id, entityType: 'WeComConfig' },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(JSON.stringify(audit.metadata).includes(marker), false, '审计日志不得包含配置值')
    assert.equal((audit.metadata as any)?.changedFields?.includes('callbackToken'), true)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_wecom_config_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'WeComConfig' AND NEW."userId" = '${admin.id}' THEN
          RAISE EXCEPTION 'forced wecom config audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_wecom_config_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_wecom_config_audit()`)
    triggerInstalled = true
    const failed = await request('/api/wecom/config', {
      method: 'PUT', headers: adminAuth,
      body: JSON.stringify({ ...updateBody, callbackToken: `${marker}-must-rollback` }),
    })
    assert.equal(failed.status, 500, JSON.stringify(failed))
    assert.equal((await prisma.weComConfig.findUniqueOrThrow({ where: { tenantId: tenant.id } })).callbackToken, marker)

    console.log(JSON.stringify({
      ok: true,
      strictPublicOAuthInput: true,
      adminBoundary: true,
      superAdminCompatibility: true,
      secretFreeAtomicAudit: true,
      secretFreeConfigRead: true,
      externalWeComCalls: 0,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_wecom_config_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_wecom_config_audit()')
    }
    await prisma.opLog.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.weComConfig.deleteMany({ where: { tenantId: tenant.id } })
    if (originalConfig) await prisma.weComConfig.create({ data: originalConfig as any })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
