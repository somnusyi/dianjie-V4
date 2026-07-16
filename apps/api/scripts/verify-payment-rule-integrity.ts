import 'dotenv/config'
import assert from 'node:assert/strict'
import { createSigner } from 'fast-jwt'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 付款规则验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) {
    throw new Error('安全护栏: 付款规则验证只允许本地服务')
  }
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
  const tenant = await prisma.tenant.create({
    data: { name: '付款规则隔离验证', slug: `local-payment-rules-${suffix}` },
  })
  const [admin, finance, manager, supplier] = await prisma.$transaction([
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '付款规则管理员', email: `admin-${suffix}@local.invalid`,
      phone: `16${suffix.slice(-9)}`, password: 'not-used', role: 'ADMIN', status: 'ACTIVE',
    } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '付款规则财务', email: `finance-${suffix}@local.invalid`,
      phone: `17${suffix.slice(-9)}`, password: 'not-used', role: 'FINANCE', status: 'ACTIVE',
    } }),
    prisma.user.create({ data: {
      tenantId: tenant.id, name: '付款规则店长', email: `manager-${suffix}@local.invalid`,
      phone: `18${suffix.slice(-9)}`, password: 'not-used', role: 'MANAGER', status: 'ACTIVE',
    } }),
    prisma.supplier.create({ data: { tenantId: tenant.id, no: 'SUP-LOCAL-RULE', name: '付款规则测试供应商' } }),
  ])
  const sign = createSigner({
    key: process.env.JWT_SECRET || 'local-development-only-jwt-secret',
    expiresIn: 2 * 60 * 60 * 1000,
  })
  const tokenFor = (user: typeof admin) => sign({
    userId: user.id, tenantId: tenant.id, role: user.role,
    storeId: null, supplierId: null, typ: 'access', ver: 0,
  })
  const adminToken = tokenFor(admin)
  const financeToken = tokenFor(finance)
  const managerToken = tokenFor(manager)
  let triggerInstalled = false

  try {
    assert.equal((await request('/api/payment-rules', managerToken)).status, 403)
    assert.equal((await request('/api/payment-rules/evaluate', managerToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, amount: 100 }),
    })).status, 403)
    assert.equal((await request('/api/payment-rules', adminToken, {
      method: 'POST', body: JSON.stringify({
        name: '伪造规则', condition: 'FORGED', action: 'auto_pay', forged: true,
      }),
    })).status, 400)
    assert.equal((await request('/api/payment-rules', adminToken, {
      method: 'POST', body: JSON.stringify({ name: '缺阈值规则', condition: 'AMOUNT_OVER', action: 'auto_pay' }),
    })).status, 400)
    assert.equal((await request('/api/payment-rules/evaluate', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: 'missing', amount: 100 }),
    })).status, 400)
    assert.equal((await request('/api/payment-rules/evaluate', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, amount: -1 }),
    })).status, 400)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_payment_rule_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'PaymentRule' AND NEW."userId" = '${admin.id}' THEN
          RAISE EXCEPTION 'forced payment rule audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_payment_rule_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_payment_rule_audit()`)
    triggerInstalled = true
    const failedCreate = await request('/api/payment-rules', adminToken, {
      method: 'POST', body: JSON.stringify({
        name: '必须回滚', condition: 'AMOUNT_OVER', threshold: 1000, action: 'auto_pay', priority: 1,
      }),
    })
    assert.equal(failedCreate.status, 500, JSON.stringify(failedCreate))
    assert.equal(await prisma.paymentRule.count({ where: { tenantId: tenant.id } }), 0)
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_payment_rule_audit_trigger ON op_logs')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_payment_rule_audit()')
    triggerInstalled = false

    const created = await request('/api/payment-rules', adminToken, {
      method: 'POST', body: JSON.stringify({
        name: '高额才自动', description: '低于阈值必须走安全默认',
        condition: 'AMOUNT_OVER', threshold: 1_000_000, action: 'auto_pay', priority: 10,
      }),
    })
    assert.equal(created.status, 200, JSON.stringify(created))
    assert.equal(await prisma.opLog.count({ where: { tenantId: tenant.id, targetId: created.body.id, entityType: 'PaymentRule' } }), 1)

    const safeDefault = await request('/api/payment-rules/evaluate', financeToken, {
      method: 'POST', body: JSON.stringify({ supplierId: supplier.id, amount: 100 }),
    })
    assert.equal(safeDefault.status, 200, JSON.stringify(safeDefault))
    assert.equal(safeDefault.body.action, 'require_approval')
    assert.equal(safeDefault.body.needApproval, true)
    assert.equal((await request(`/api/payment-rules/${created.body.id}`, adminToken, {
      method: 'PATCH', body: JSON.stringify({ condition: 'NEW_SUPPLIER' }),
    })).status, 400, '切换为无阈值条件时必须显式清空旧阈值')

    const changed = await request(`/api/payment-rules/${created.body.id}`, adminToken, {
      method: 'PATCH', body: JSON.stringify({ condition: 'NEW_SUPPLIER', threshold: null, action: 'block' }),
    })
    assert.equal(changed.status, 200, JSON.stringify(changed))
    assert.equal(changed.body.condition, 'NEW_SUPPLIER')
    assert.equal(changed.body.threshold, null)

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_payment_rule_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'PaymentRule' AND NEW."userId" = '${admin.id}' THEN
          RAISE EXCEPTION 'forced payment rule audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_payment_rule_audit_trigger BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_payment_rule_audit()`)
    triggerInstalled = true
    assert.equal((await request(`/api/payment-rules/${created.body.id}`, adminToken, {
      method: 'PATCH', body: JSON.stringify({ name: '不应落库的名字' }),
    })).status, 500)
    assert.equal((await prisma.paymentRule.findUniqueOrThrow({ where: { id: created.body.id } })).name, '高额才自动')
    assert.equal((await request(`/api/payment-rules/${created.body.id}`, adminToken, { method: 'DELETE' })).status, 500)
    assert.equal(await prisma.paymentRule.count({ where: { id: created.body.id } }), 1)

    console.log(JSON.stringify({
      ok: true,
      strictRuleSchema: true,
      roleAndSupplierBoundary: true,
      createUpdateDeleteAuditAtomic: true,
      safeDefaultRequiresApproval: true,
      externalPaymentActions: 0,
    }))
  } finally {
    if (triggerInstalled) {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_payment_rule_audit_trigger ON op_logs')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_payment_rule_audit()')
    }
    await prisma.opLog.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.paymentRule.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.user.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
