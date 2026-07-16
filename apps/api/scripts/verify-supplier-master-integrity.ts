import 'dotenv/config'
import assert from 'node:assert/strict'
import { createSigner } from 'fast-jwt'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 供应商主数据验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) throw new Error('安全护栏: 只允许本地 API')
}

async function request(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function main() {
  assertLocalOnly()
  const suffix = String(Date.now()).slice(-10)
  const tenant = await prisma.tenant.create({ data: { name: '供应商主数据隔离验证', slug: `local-supplier-master-${suffix}` } })
  const [ownSupplier, otherSupplier] = await prisma.$transaction([
    prisma.supplier.create({ data: {
      tenantId: tenant.id, no: 'SUP-OWN', name: '自有供应商', bankAccount: '622200001111', bankName: '测试银行',
    } }),
    prisma.supplier.create({ data: {
      tenantId: tenant.id, no: 'SUP-OTHER', name: '其他供应商', bankAccount: '622200009999', status: 'DISABLED',
    } }),
  ])
  const [admin, finance, manager, supplierOwner] = await prisma.$transaction([
    prisma.user.create({ data: { tenantId: tenant.id, name: '主数据管理员', email: `admin-${suffix}@local.invalid`, password: 'x', role: 'ADMIN' } }),
    prisma.user.create({ data: { tenantId: tenant.id, name: '主数据财务', email: `finance-${suffix}@local.invalid`, password: 'x', role: 'FINANCE' } }),
    prisma.user.create({ data: { tenantId: tenant.id, name: '主数据店长', email: `manager-${suffix}@local.invalid`, password: 'x', role: 'MANAGER' } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '供应商负责人', email: `owner-${suffix}@local.invalid`, password: 'x',
      role: 'SUPPLIER_OWNER', supplierId: ownSupplier.id,
    } }),
  ])
  const sign = createSigner({ key: process.env.JWT_SECRET || 'local-development-only-jwt-secret', expiresIn: 7_200_000 })
  const tokenFor = (user: typeof admin) => sign({
    userId: user.id, tenantId: tenant.id, role: user.role,
    storeId: null, supplierId: user.supplierId, typ: 'access', ver: 0,
  })
  const adminToken = tokenFor(admin)
  const financeToken = tokenFor(finance)
  const managerToken = tokenFor(manager)
  const ownerToken = tokenFor(supplierOwner)
  let triggerInstalled = false

  async function installAuditFailure() {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_supplier_master_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'Supplier' AND NEW."userId" = '${finance.id}' THEN
          RAISE EXCEPTION 'forced supplier master audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_supplier_master_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_supplier_master_audit()`)
    triggerInstalled = true
  }
  async function removeAuditFailure() {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_supplier_master_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_supplier_master_audit()')
    triggerInstalled = false
  }

  try {
    // 先用管理员填充缓存，再验证低权限请求不会命中同一份敏感缓存。
    const adminList = await request('/api/suppliers', adminToken)
    assert.equal(adminList.status, 200)
    assert.equal(adminList.body.some((item: any) => item.bankAccount === ownSupplier.bankAccount), true)
    const managerList = await request('/api/suppliers', managerToken)
    assert.equal(managerList.status, 200)
    assert.deepEqual(managerList.body.map((item: any) => item.id), [ownSupplier.id])
    assert.equal('bankAccount' in managerList.body[0], false)
    const ownerList = await request('/api/suppliers', ownerToken)
    assert.equal(ownerList.status, 200)
    assert.deepEqual(ownerList.body.map((item: any) => item.id), [ownSupplier.id])
    assert.equal(ownerList.body[0].bankAccount, ownSupplier.bankAccount)
    assert.equal((await request('/api/suppliers?status=FORGED', adminToken)).status, 400)
    assert.equal((await request('/api/suppliers?forged=1', adminToken)).status, 400)
    assert.equal((await request(`/api/suppliers/${ownSupplier.id}`, ownerToken, {
      method: 'PATCH', body: JSON.stringify({ bankAccount: 'attacker-account' }),
    })).status, 403)

    await installAuditFailure()
    const failedCreate = await request('/api/suppliers', financeToken, {
      method: 'POST', body: JSON.stringify({
        no: 'SUP-ROLLBACK', name: '创建必须回滚', creditType: 'WEEKLY', bankCode: 'LOCAL-CODE',
      }),
    })
    assert.equal(failedCreate.status, 500, JSON.stringify(failedCreate))
    assert.equal(await prisma.supplier.count({ where: { tenantId: tenant.id, no: 'SUP-ROLLBACK' } }), 0)
    await removeAuditFailure()

    const created = await request('/api/suppliers', financeToken, {
      method: 'POST', body: JSON.stringify({
        no: 'SUP-VALID', name: '合法新供应商', creditType: 'ON_DELIVERY', creditDays: 0,
        bankName: '新供应商银行', bankAccount: '622200007777', bankAccountName: '合法新供应商', bankCode: 'LOCAL-CODE',
      }),
    })
    assert.equal(created.status, 201, JSON.stringify(created))
    assert.equal(created.body.creditType, 'ON_DELIVERY')
    const createdAudit = await prisma.opLog.findFirstOrThrow({ where: { tenantId: tenant.id, targetId: created.body.id, entityType: 'Supplier' } })
    assert.equal(JSON.stringify(createdAudit.metadata).includes('622200007777'), false)

    await installAuditFailure()
    const failedUpdate = await request(`/api/suppliers/${created.body.id}`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankAccount: '622200008888' }),
    })
    assert.equal(failedUpdate.status, 500, JSON.stringify(failedUpdate))
    assert.equal((await prisma.supplier.findUniqueOrThrow({ where: { id: created.body.id } })).bankAccount, '622200007777')
    const failedToggle = await request(`/api/suppliers/${created.body.id}/toggle`, financeToken, { method: 'PATCH', body: '{}' })
    assert.equal(failedToggle.status, 500, JSON.stringify(failedToggle))
    assert.equal((await prisma.supplier.findUniqueOrThrow({ where: { id: created.body.id } })).status, 'ENABLED')
    await removeAuditFailure()

    const updated = await request(`/api/suppliers/${created.body.id}`, financeToken, {
      method: 'PATCH', body: JSON.stringify({ bankAccount: '622200008888', creditType: 'WEEKLY' }),
    })
    assert.equal(updated.status, 200, JSON.stringify(updated))
    assert.equal(updated.body.bankAccount, '622200008888')
    const updateAudit = await prisma.opLog.findFirstOrThrow({
      where: { tenantId: tenant.id, targetId: created.body.id, action: { startsWith: '更新供应商' } },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(JSON.stringify(updateAudit.metadata).includes('622200008888'), false)

    console.log(JSON.stringify({
      ok: true,
      roleScopedSensitiveProjection: true,
      roleSeparatedCache: true,
      creditTypeCompatibility: true,
      createUpdateToggleAuditAtomic: true,
      bankValuesExcludedFromAudit: true,
    }))
  } finally {
    if (triggerInstalled) await removeAuditFailure()
    await prisma.opLog.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.user.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
