import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'local-invite-test-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 邀请完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 邀请完整性验证只允许本地服务')
  }
}

function token() {
  return crypto.randomBytes(24).toString('base64url')
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
  const phones = [`13${suffix}`, `15${suffix}`, `17${suffix}`, `18${suffix}`]
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const password = await bcrypt.hash(PASSWORD, 4)
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: '邀请完整性管理员',
      phone: phones[3],
      email: `invite-admin-${suffix}@local.invalid`,
      password,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
    },
  })
  const inviteIds: string[] = []
  const userIds: string[] = [admin.id]
  let triggerInstalled = false

  try {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: phones[3], password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login))
    const auth = { authorization: `Bearer ${login.body.token}` }

    const concurrentInvite = await prisma.inviteToken.create({
      data: {
        tenantId: tenant.id,
        token: token(),
        role: 'FINANCE',
        invitedById: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    inviteIds.push(concurrentInvite.id)
    const concurrent = await Promise.all([
      request(`/api/invite-accept/${concurrentInvite.token}/accept`, {
        method: 'POST', body: JSON.stringify({ name: '并发邀请甲', phone: phones[0], password: PASSWORD }),
      }),
      request(`/api/invite-accept/${concurrentInvite.token}/accept`, {
        method: 'POST', body: JSON.stringify({ name: '并发邀请乙', phone: phones[1], password: PASSWORD }),
      }),
    ])
    assert.equal(concurrent.filter(item => item.status === 201).length, 1, JSON.stringify(concurrent))
    assert.equal(concurrent.filter(item => item.status === 400).length, 1, JSON.stringify(concurrent))
    const concurrentUsers = await prisma.user.findMany({
      where: { tenantId: tenant.id, phone: { in: phones.slice(0, 2) } }, select: { id: true, phone: true },
    })
    assert.equal(concurrentUsers.length, 1, '一个邀请并发消费只能创建一个账号')
    userIds.push(...concurrentUsers.map(user => user.id))
    const consumed = await prisma.inviteToken.findUniqueOrThrow({ where: { id: concurrentInvite.id } })
    assert.equal(consumed.consumedByUserId, concurrentUsers[0].id)
    assert.equal(await prisma.opLog.count({ where: { targetId: concurrentInvite.id, entityType: 'InviteToken' } }), 1)

    const rollbackInvite = await prisma.inviteToken.create({
      data: {
        tenantId: tenant.id,
        token: token(),
        role: 'FINANCE',
        invitedById: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    inviteIds.push(rollbackInvite.id)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_invite_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'InviteToken' AND NEW.action LIKE '通过邀请链接激活账号%' THEN
          RAISE EXCEPTION 'forced invite audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_invite_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_invite_audit()`)
    triggerInstalled = true
    const failed = await request(`/api/invite-accept/${rollbackInvite.token}/accept`, {
      method: 'POST', body: JSON.stringify({ name: '审计回滚邀请', phone: phones[2], password: PASSWORD }),
    })
    assert.equal(failed.status, 500, JSON.stringify(failed))
    assert.equal(await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[2] } }), 0)
    assert.equal((await prisma.inviteToken.findUniqueOrThrow({ where: { id: rollbackInvite.id } })).consumedAt, null)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_invite_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_invite_audit()')
    triggerInstalled = false
    const recovered = await request(`/api/invite-accept/${rollbackInvite.token}/accept`, {
      method: 'POST', body: JSON.stringify({ name: '审计回滚邀请', phone: phones[2], password: PASSWORD }),
    })
    assert.equal(recovered.status, 201, JSON.stringify(recovered))
    const recoveredUser = await prisma.user.findUniqueOrThrow({ where: { tenantId_phone: { tenantId: tenant.id, phone: phones[2] } } })
    userIds.push(recoveredUser.id)
    assert.equal((await prisma.inviteToken.findUniqueOrThrow({ where: { id: rollbackInvite.id } })).consumedByUserId, recoveredUser.id)

    const forged = await request('/api/invites', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ role: 'FINANCE', expiresHours: 1, forged: true }),
    })
    assert.equal(forged.status, 400)
    const created = await request('/api/invites', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ role: 'FINANCE', expiresHours: 1, note: '撤销消费竞争验证' }),
    })
    assert.equal(created.status, 201, JSON.stringify(created))
    inviteIds.push(created.body.id)
    assert.equal(await prisma.opLog.count({ where: { targetId: created.body.id, action: { startsWith: '创建账号邀请' } } }), 1)

    const revokePhone = `19${suffix}`
    const [revoked, accepted] = await Promise.all([
      request(`/api/invites/${created.body.id}`, { method: 'DELETE', headers: auth }),
      request(`/api/invite-accept/${created.body.token}/accept`, {
        method: 'POST', body: JSON.stringify({ name: '撤销竞争邀请', phone: revokePhone, password: PASSWORD }),
      }),
    ])
    assert.equal([revoked.status, accepted.status].filter(status => status === 400).length, 1, JSON.stringify({ revoked, accepted }))
    assert.equal([revoked.status, accepted.status].filter(status => status === 200 || status === 201).length, 1, JSON.stringify({ revoked, accepted }))
    const racedInvite = await prisma.inviteToken.findUniqueOrThrow({ where: { id: created.body.id } })
    const racedUser = await prisma.user.findUnique({ where: { tenantId_phone: { tenantId: tenant.id, phone: revokePhone } } })
    assert.notEqual(Boolean(racedInvite.revokedAt), Boolean(racedInvite.consumedAt), '撤销与消费必须只有一个终态')
    assert.equal(Boolean(racedUser), Boolean(racedInvite.consumedAt))
    if (racedUser) userIds.push(racedUser.id)

    assert.equal((await request('/api/invite-accept/not-a-token')).status, 400)
    console.log(JSON.stringify({
      ok: true,
      concurrentSingleConsumer: true,
      auditFailureAtomicRollback: true,
      revokeAcceptSingleTerminalState: true,
      createAndAcceptInputsStrict: true,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_invite_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_invite_audit()')
    }
    if (inviteIds.length) await prisma.opLog.deleteMany({ where: { targetId: { in: inviteIds } } })
    await prisma.opLog.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.inviteToken.deleteMany({ where: { id: { in: inviteIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
