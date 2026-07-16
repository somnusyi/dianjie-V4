import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'local-application-test-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 申请决策验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 申请决策验证只允许本地服务')
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
  const phones = ['13', '14', '15', '16', '17', '18', '19'].map(prefix => `${prefix}${suffix}`)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '申请决策测试管理员', phone: phones[6],
      email: `application-admin-${suffix}@local.invalid`, password: passwordHash,
      role: 'SUPER_ADMIN', status: 'ACTIVE',
    },
  })
  const applicationIds: string[] = []
  let triggerInstalled = false

  const createApplication = async (index: number, label: string) => {
    const application = await prisma.userApplication.create({
      data: {
        tenantId: tenant.id, name: `申请人${label}`, phone: phones[index], passwordHash,
        requestedRole: 'SUPPLIER_OWNER', supplierName: `本地供应商${label}-${suffix}`,
        status: 'PENDING',
      },
    })
    applicationIds.push(application.id)
    return application
  }

  try {
    const login = await request('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ identifier: phones[6], password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login))
    const auth = { authorization: `Bearer ${login.body.token}` }

    const duplicated = await createApplication(0, '并发双批')
    const doubleApproval = await Promise.all([
      request(`/api/applications/${duplicated.id}/approve`, { method: 'POST', headers: auth, body: '{}' }),
      request(`/api/applications/${duplicated.id}/approve`, { method: 'POST', headers: auth, body: '{}' }),
    ])
    assert.equal(doubleApproval.filter(item => item.status === 200).length, 1, JSON.stringify(doubleApproval))
    assert.equal(doubleApproval.filter(item => item.status === 400).length, 1, JSON.stringify(doubleApproval))
    assert.equal(await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[0] } }), 1)
    assert.equal(await prisma.supplier.count({ where: { tenantId: tenant.id, contactPhone: phones[0] } }), 1)
    assert.equal(await prisma.opLog.count({ where: { targetId: duplicated.id, entityType: 'UserApplication' } }), 1)

    const terminalRace = await createApplication(1, '批拒竞争')
    const [approved, rejected] = await Promise.all([
      request(`/api/applications/${terminalRace.id}/approve`, { method: 'POST', headers: auth, body: '{}' }),
      request(`/api/applications/${terminalRace.id}/reject`, {
        method: 'POST', headers: auth, body: JSON.stringify({ reason: '本地并发终态验证' }),
      }),
    ])
    assert.equal([approved.status, rejected.status].filter(status => status === 200).length, 1, JSON.stringify({ approved, rejected }))
    assert.equal([approved.status, rejected.status].filter(status => status === 400).length, 1, JSON.stringify({ approved, rejected }))
    const raced = await prisma.userApplication.findUniqueOrThrow({ where: { id: terminalRace.id } })
    const racedUserCount = await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[1] } })
    const racedSupplierCount = await prisma.supplier.count({ where: { tenantId: tenant.id, contactPhone: phones[1] } })
    assert.equal(racedUserCount, raced.status === 'APPROVED' ? 1 : 0)
    assert.equal(racedSupplierCount, raced.status === 'APPROVED' ? 1 : 0)
    assert.equal(await prisma.opLog.count({ where: { targetId: terminalRace.id, entityType: 'UserApplication' } }), 1)

    const rollback = await createApplication(2, '审计回滚')
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_application_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'UserApplication' AND NEW."targetId" = '${rollback.id}' THEN
          RAISE EXCEPTION 'forced application audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_application_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_application_audit()`)
    triggerInstalled = true
    const failed = await request(`/api/applications/${rollback.id}/approve`, { method: 'POST', headers: auth, body: '{}' })
    assert.equal(failed.status, 500, JSON.stringify(failed))
    assert.equal((await prisma.userApplication.findUniqueOrThrow({ where: { id: rollback.id } })).status, 'PENDING')
    assert.equal(await prisma.user.count({ where: { tenantId: tenant.id, phone: phones[2] } }), 0)
    assert.equal(await prisma.supplier.count({ where: { tenantId: tenant.id, contactPhone: phones[2] } }), 0)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_application_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_application_audit()')
    triggerInstalled = false
    const recovered = await request(`/api/applications/${rollback.id}/approve`, { method: 'POST', headers: auth, body: '{}' })
    assert.equal(recovered.status, 200, JSON.stringify(recovered))

    const sequenceA = await createApplication(3, '编号并发甲')
    const sequenceB = await createApplication(4, '编号并发乙')
    const sequenceResults = await Promise.all([
      request(`/api/applications/${sequenceA.id}/approve`, { method: 'POST', headers: auth, body: '{}' }),
      request(`/api/applications/${sequenceB.id}/approve`, { method: 'POST', headers: auth, body: '{}' }),
    ])
    assert.deepEqual(sequenceResults.map(item => item.status).sort(), [200, 200], JSON.stringify(sequenceResults))
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenant.id, contactPhone: { in: [phones[3], phones[4]] } }, select: { no: true },
    })
    assert.equal(suppliers.length, 2)
    assert.equal(new Set(suppliers.map(item => item.no)).size, 2, '不同申请并发审批必须取得不同供应商编号')

    assert.equal((await request('/api/applications?status=FORGED', { headers: auth })).status, 400)
    console.log(JSON.stringify({
      ok: true,
      duplicateApprovalSingleEffect: true,
      approveRejectSingleTerminalState: true,
      auditFailureAtomicRollback: true,
      supplierSequenceSerialized: true,
      listQueryStrict: true,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_application_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_application_audit()')
    }
    if (applicationIds.length) await prisma.opLog.deleteMany({ where: { targetId: { in: applicationIds } } })
    const testUsers = await prisma.user.findMany({ where: { tenantId: tenant.id, phone: { in: phones } }, select: { id: true } })
    await prisma.opLog.deleteMany({ where: { userId: { in: testUsers.map(user => user.id) } } })
    await prisma.user.deleteMany({ where: { id: { in: testUsers.map(user => user.id) } } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenant.id, contactPhone: { in: phones } } })
    await prisma.userApplication.deleteMany({ where: { id: { in: applicationIds } } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
