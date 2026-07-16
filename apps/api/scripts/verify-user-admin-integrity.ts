import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'local-user-admin-test-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 用户管理验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 用户管理验证只允许本地服务')
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
  const phones = ['13', '15', '17', '18', '19'].map(prefix => `${prefix}${suffix}`)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const [superAdmin, admin, target] = await prisma.$transaction([
    prisma.user.create({
      data: {
        tenantId: tenant.id, name: '用户管理超管', phone: phones[4],
        email: `user-super-${suffix}@local.invalid`, password: passwordHash,
        role: 'SUPER_ADMIN', status: 'ACTIVE',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id, name: '用户管理管理员', phone: phones[3],
        email: `user-admin-${suffix}@local.invalid`, password: passwordHash,
        role: 'ADMIN', status: 'ACTIVE',
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id, name: '用户管理目标', phone: phones[2],
        email: `user-target-${suffix}@local.invalid`, password: passwordHash,
        role: 'FINANCE', status: 'ACTIVE',
      },
    }),
  ])
  const userIds = [superAdmin.id, admin.id, target.id]
  let triggerInstalled = false

  try {
    const [superLogin, adminLogin] = await Promise.all([
      request('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ identifier: phones[4], password: PASSWORD, tenantSlug: TENANT_SLUG }),
      }),
      request('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ identifier: phones[3], password: PASSWORD, tenantSlug: TENANT_SLUG }),
      }),
    ])
    assert.equal(superLogin.status, 200, JSON.stringify(superLogin))
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin))
    const adminAuth = { authorization: `Bearer ${adminLogin.body.token}` }
    const superAuth = { authorization: `Bearer ${superLogin.body.token}` }

    const escalationCreate = await request('/api/users', {
      method: 'POST', headers: adminAuth,
      body: JSON.stringify({ name: '非法超管', phone: phones[0], password: PASSWORD, role: 'SUPER_ADMIN' }),
    })
    assert.equal(escalationCreate.status, 403)
    assert.equal(await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[0] } }), 0)
    assert.equal((await request(`/api/users/${target.id}`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    })).status, 403)
    assert.equal((await request(`/api/users/${superAdmin.id}/reset-password`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ password: `${PASSWORD}-new` }),
    })).status, 403)
    assert.equal((await request(`/api/users/${superAdmin.id}/toggle`, { method: 'PATCH', headers: adminAuth, body: '{}' })).status, 403)
    assert.equal((await request('/api/users?status=FORGED', { headers: adminAuth })).status, 400)
    assert.equal((await request(`/api/users/${target.id}`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ forged: true }),
    })).status, 400)
    assert.equal((await request('/api/users', {
      method: 'POST', headers: adminAuth,
      body: JSON.stringify({ name: '无供应商绑定', phone: phones[0], password: PASSWORD, role: 'SUPPLIER_STAFF' }),
    })).status, 400)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_user_admin_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'User' AND NEW."userId" = '${admin.id}' THEN
          RAISE EXCEPTION 'forced user admin audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_user_admin_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_user_admin_audit()`)
    triggerInstalled = true
    const failedCreate = await request('/api/users', {
      method: 'POST', headers: adminAuth,
      body: JSON.stringify({ name: '审计回滚新用户', phone: phones[0], password: PASSWORD, role: 'FINANCE' }),
    })
    assert.equal(failedCreate.status, 500, JSON.stringify(failedCreate))
    assert.equal(await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[0] } }), 0)
    const originalName = target.name
    const failedUpdate = await request(`/api/users/${target.id}`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ name: '不应落库的名字' }),
    })
    assert.equal(failedUpdate.status, 500, JSON.stringify(failedUpdate))
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).name, originalName)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_user_admin_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_user_admin_audit()')
    triggerInstalled = false

    const recoveredCreate = await request('/api/users', {
      method: 'POST', headers: adminAuth,
      body: JSON.stringify({ name: '审计恢复新用户', phone: phones[0], password: PASSWORD, role: 'FINANCE' }),
    })
    assert.equal(recoveredCreate.status, 201, JSON.stringify(recoveredCreate))
    userIds.push(recoveredCreate.body.id)
    assert.equal(await prisma.opLog.count({ where: { targetId: recoveredCreate.body.id, entityType: 'User' } }), 1)
    assert.equal((await request(`/api/users/${target.id}`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({
        name: '审计恢复后的名字', email: target.email, phone: target.phone,
        role: target.role, storeId: null,
      }),
    })).status, 200)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).name, '审计恢复后的名字')
    assert.equal((await request(`/api/users/${target.id}/reset-password`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ password: `${PASSWORD}-reset` }),
    })).status, 200)
    const resetTarget = await prisma.user.findUniqueOrThrow({ where: { id: target.id } })
    assert.equal(resetTarget.authVersion, 1)
    assert.equal(await bcrypt.compare(`${PASSWORD}-reset`, resetTarget.password), true)

    const allowedSuperCreate = await request('/api/users', {
      method: 'POST', headers: superAuth,
      body: JSON.stringify({ name: '合法测试超管', phone: phones[1], password: PASSWORD, role: 'SUPER_ADMIN' }),
    })
    assert.equal(allowedSuperCreate.status, 201, JSON.stringify(allowedSuperCreate))
    userIds.push(allowedSuperCreate.body.id)
    console.log(JSON.stringify({
      ok: true,
      adminPrivilegeEscalationBlocked: true,
      strictInputAndRoleBindings: true,
      createAndUpdateAuditAtomic: true,
      superAdminAuthorityPreserved: true,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_user_admin_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_user_admin_audit()')
    }
    await prisma.opLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { targetId: { in: userIds } }] } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
