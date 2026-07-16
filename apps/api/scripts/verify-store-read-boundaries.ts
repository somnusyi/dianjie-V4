import 'dotenv/config'
import assert from 'node:assert/strict'
import { createSigner } from 'fast-jwt'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 门店读取边界验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) throw new Error('安全护栏: 只允许本地 API')
}

async function request(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function main() {
  assertLocalOnly()
  const suffix = String(Date.now()).slice(-10)
  const tenant = await prisma.tenant.create({ data: { name: '门店读取隔离验证', slug: `local-store-read-${suffix}` } })
  const [storeA, storeB] = await prisma.$transaction([
    prisma.store.create({ data: {
      tenantId: tenant.id, no: 'DJ-A', name: '安全门店 A', address: '测试地址 A',
      bankAccountNo: '622200001111', invoiceTaxId: 'TAX-SECRET-A', aggregatorApiKeyEnc: 'API-SECRET-A',
    } }),
    prisma.store.create({ data: {
      tenantId: tenant.id, no: 'DJ-B', name: '安全门店 B', address: '测试地址 B',
      bankAccountNo: '622200009999', invoiceTaxId: 'TAX-SECRET-B', aggregatorApiKeyEnc: 'API-SECRET-B',
    } }),
  ])
  const [admin, manager, supplierUser] = await prisma.$transaction([
    prisma.user.create({ data: { tenantId: tenant.id, name: '门店边界管理员', email: `admin-${suffix}@local.invalid`, password: 'x', role: 'ADMIN' } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '门店 A 店长', email: `manager-${suffix}@local.invalid`, password: 'x',
      role: 'MANAGER', storeId: storeA.id, storeIds: [storeA.id],
    } }),
    prisma.user.create({ data: { tenantId: tenant.id, name: '门店边界供应商', email: `supplier-${suffix}@local.invalid`, password: 'x', role: 'SUPPLIER_STAFF' } }),
  ])
  const sign = createSigner({ key: process.env.JWT_SECRET || 'local-development-only-jwt-secret', expiresIn: 7_200_000 })
  const tokenFor = (user: typeof admin) => sign({
    userId: user.id, tenantId: tenant.id, role: user.role,
    storeId: user.storeId, supplierId: user.supplierId, typ: 'access', ver: 0,
  })
  const triggerName = 'test_fail_store_payment_audit'
  const functionName = 'test_fail_store_payment_audit_fn'

  try {
    // 先让管理员建立完整缓存，再确认低权限路径完全不复用该结果。
    const adminList = await request('/api/stores', tokenFor(admin))
    assert.equal(adminList.status, 200)
    assert.equal(adminList.body.some((store: any) => store.bankAccountNo === '622200001111'), true)
    assert.equal(adminList.body.some((store: any) => Array.isArray(store.users)), true)

    const supplierList = await request('/api/stores', tokenFor(supplierUser))
    assert.equal(supplierList.status, 200)
    assert.equal(supplierList.body.length, 2)
    for (const store of supplierList.body) {
      assert.equal('bankAccountNo' in store, false)
      assert.equal('invoiceTaxId' in store, false)
      assert.equal('aggregatorApiKeyEnc' in store, false)
      assert.equal('users' in store, false)
      assert.equal('stats' in store, false)
    }

    const managerList = await request('/api/stores', tokenFor(manager))
    assert.equal(managerList.status, 200)
    assert.deepEqual(managerList.body.map((store: any) => store.id), [storeA.id])
    assert.equal((await request(`/api/stores/${storeB.id}`, tokenFor(manager))).status, 403)
    assert.equal((await request(`/api/stores/${storeA.id}/payment-config`, tokenFor(manager))).status, 200)
    assert.equal((await request(`/api/stores/${storeB.id}/payment-config`, tokenFor(manager))).status, 403)

    const supplierDetail = await request(`/api/stores/${storeA.id}`, tokenFor(supplierUser))
    assert.equal(supplierDetail.status, 200)
    assert.equal('bankAccountNo' in supplierDetail.body.store, false)
    assert.equal(supplierDetail.body.stats, null)
    assert.deepEqual(supplierDetail.body.receipts, [])
    assert.deepEqual(supplierDetail.body.schedules, [])
    assert.deepEqual(supplierDetail.body.lossClaims, [])

    const forgedConfig = await request(`/api/stores/${storeA.id}/payment-config`, tokenFor(admin), {
      method: 'PATCH', body: JSON.stringify({ bankName: '测试银行', forgedAdmin: true }),
    })
    assert.equal(forgedConfig.status, 400)

    const configured = await request(`/api/stores/${storeA.id}/payment-config`, tokenFor(admin), {
      method: 'PATCH',
      body: JSON.stringify({
        paymentChannelType: 'AGGREGATOR', aggregatorVendor: 'qianqian',
        aggregatorApiKey: 'LOCAL-API-SECRET', bankAccountNo: '6222 0000-1234',
        bankAccountName: '本地测试户名', bankName: '本地测试银行', autoSyncRevenue: false,
      }),
    })
    assert.equal(configured.status, 200)
    const stored = await prisma.store.findUniqueOrThrow({ where: { id: storeA.id } })
    assert.equal(stored.bankAccountNo, '622200001234')
    assert.equal(stored.aggregatorApiKeyEnc, 'LOCAL-API-SECRET')
    const audit = await prisma.opLog.findFirstOrThrow({
      where: { tenantId: tenant.id, targetId: storeA.id, action: { startsWith: '更新门店收款配置' } },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(JSON.stringify(audit.metadata).includes('LOCAL-API-SECRET'), false)
    assert.equal((audit.metadata as any)?.changedFields?.includes('aggregatorApiKey'), true)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = '${tenant.id}' AND NEW.action LIKE '更新门店收款配置%' THEN
          RAISE EXCEPTION 'forced store payment audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON op_logs`)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()
    `)
    const failedAudit = await request(`/api/stores/${storeA.id}/payment-config`, tokenFor(admin), {
      method: 'PATCH', body: JSON.stringify({ bankName: '不应保存的银行' }),
    })
    assert.equal(failedAudit.status, 500)
    assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeA.id } })).bankName, '本地测试银行')
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON op_logs`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`)

    console.log(JSON.stringify({
      ok: true,
      sensitiveStoreProjectionRestricted: true,
      managerStoreScope: true,
      supplierFinancialMetricsHidden: true,
      adminCompatibilityPreserved: true,
      managerPaymentConfigScoped: true,
      paymentConfigStrictAndAtomic: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON op_logs`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {})
    await prisma.opLog.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.user.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.store.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
