import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { estimatedStoreInventory } from '../src/services/storeInventory'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 店内报损验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function main() {
  assertLocalOnly()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, storeId: store.id, role: 'MANAGER' } })
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const suffix = Date.now().toString(36).toUpperCase()
  const startedAt = new Date()
  const reason = `自动报损验证${suffix}`.slice(0, 30)
  const product = await prisma.product.create({
    data: { tenantId: tenant.id, supplierId: supplier.id, code: `LOSS-${suffix}`, name: `报损验证食材-${suffix}`, unit: 'kg', price: 99, stock: 50 },
  })
  const unmappedProduct = await prisma.product.create({
    data: { tenantId: tenant.id, supplierId: supplier.id, code: `LOSS-U-${suffix}`, name: `未映射报损食材-${suffix}`, unit: 'kg', price: 88, stock: 20 },
  })
  const highCostProduct = await prisma.product.create({
    data: { tenantId: tenant.id, supplierId: supplier.id, code: `LOSS-H-${suffix}`, name: `高成本报损食材-${suffix}`, unit: 'kg', price: 20_000, stock: 0 },
  })
  const foreignTenant = await prisma.tenant.create({ data: { name: `报损边界验证-${suffix}`, slug: `loss-boundary-${suffix.toLowerCase()}` } })
  const foreignProduct = await prisma.product.create({
    data: { tenantId: foreignTenant.id, code: `LOSS-F-${suffix}`, name: '跨租户报损食材', unit: 'kg', price: 66 },
  })
  const reviewer = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '店内报损并发审核员', email: `manual-loss-review-${suffix}@local.test`,
      password: await bcrypt.hash(PASSWORD, 10), role: 'CHEF_DIRECTOR', status: 'ACTIVE',
    },
  })
  const snapshot = await prisma.inventorySnapshot.create({
    data: {
      tenantId: tenant.id, storeId: store.id, snapshotDate: new Date('2026-07-14T00:00:00.000Z'),
      sourceFilename: '店内报损自动化验证.xlsx', sourceHash: `loss-verify-${suffix}`,
      totalValue: 21_000, itemCount: 2, nonzeroCount: 2, zeroCount: 0, matchedCount: 2,
      items: { create: [
        { productId: product.id, section: '验证', rawName: product.name, unit: 'kg', quantity: 100, unitPrice: 10, amount: 1000, sortOrder: 1 },
        { productId: highCostProduct.id, section: '验证', rawName: highCostProduct.name, unit: 'kg', quantity: 1, unitPrice: 20_000, amount: 20_000, sortOrder: 2 },
      ] },
    },
  })
  const receipt = await prisma.receipt.create({
    data: {
      tenantId: tenant.id, no: `RKLOSS${suffix}`, storeId: store.id, supplierId: supplier.id,
      deliveryDate: new Date('2026-07-15T00:00:00.000Z'), totalAmount: 300,
      status: 'CONFIRMED', isManual: true, confirmedAt: new Date(), createdById: manager.id,
      items: { create: [{ productId: product.id, quantity: 20, unitPrice: 15, amount: 300 }] },
    },
  })
  const createdClaimIds: string[] = []
  const failureFunction = `local_manual_loss_fail_${suffix.toLowerCase()}`
  const failureTrigger = `local_manual_loss_trigger_${suffix.toLowerCase()}`
  let failureTriggerInstalled = false
  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST', body: JSON.stringify({ identifier: manager.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token
    const reviewerLogin = await api('/api/auth/login', null, {
      method: 'POST', body: JSON.stringify({ identifier: reviewer.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(reviewerLogin.status, 200, JSON.stringify(reviewerLogin.body))
    const closedArrivalClaim = await api('/api/loss-claims', token, {
      method: 'POST',
      body: JSON.stringify({
        purchaseOrderId: 'schema-check-only', description: '重复行必须在查订单前被拒绝',
        items: [{ productId: product.id, receivedQty: 1 }, { productId: product.id, receivedQty: 1 }],
      }),
    })
    assert.equal(closedArrivalClaim.status, 409, '验收后补报入口必须明确关闭')
    assert.equal(closedArrivalClaim.body.code, 'ARRIVAL_CLAIM_WINDOW_CLOSED')

    for (const body of [
      { items: [{ productId: product.id, quantity: -1 }], reason },
      { items: [{ productId: product.id, quantity: 1 }, { productId: product.id, quantity: 2 }], reason },
      { items: [{ productId: product.id, quantity: 0.001 }], reason },
    ]) {
      assert.equal((await api('/api/loss-claims/manual', token, { method: 'POST', body: JSON.stringify(body) })).status, 400)
    }
    assert.equal((await api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: foreignProduct.id, quantity: 1 }], reason }),
    })).status, 400, '跨租户食材必须拒绝')
    assert.equal((await api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: unmappedProduct.id, quantity: 1 }], reason }),
    })).status, 409, '未进入门店库存基准的食材必须拒绝')
    assert.equal((await api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: highCostProduct.id, quantity: 1_000_000 }], reason }),
    })).status, 400, '店内报损金额超过数据库上限时必须在写入前拒绝')

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW.action LIKE '店内报损 %' THEN RAISE EXCEPTION 'local manual loss failure injection'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${failureTrigger}" BEFORE INSERT ON op_logs
      FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
    `)
    failureTriggerInstalled = true
    const failed = await api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 1, unitPrice: 99999 }], reason }),
    })
    assert.equal(failed.status, 500)
    assert.equal(await prisma.lossClaim.count({ where: { tenantId: tenant.id, reason, createdAt: { gte: startedAt } } }), 0, '日志失败时报损单必须回滚')
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON op_logs`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    failureTriggerInstalled = false

    const first = await api('/api/loss-claims/manual', token, {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: product.id, quantity: 2, unitPrice: 99999 }], reason, description: '客户端价格必须被忽略' }),
    })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    createdClaimIds.push(first.body.id)
    // main 语义: 金额按完整移动均价 (10.833333) 计算后两位舍入 = 21.67, unitPrice 仍为两位兼容展示
    assert.equal(Number(first.body.totalLossAmount), 21.67)
    assert.equal(Number(first.body.items[0].unitPrice), 10.83, '必须使用盘点+收货形成的移动平均成本')
    assert.equal(first.body.status, 'AUTO_APPROVED')

    const concurrent = await Promise.all([1, 2].map(index => api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }], reason, description: `并发${index}` }),
    })))
    assert.deepEqual(concurrent.map(result => result.status), [201, 201])
    createdClaimIds.push(...concurrent.map(result => result.body.id))
    assert.equal(new Set(concurrent.map(result => result.body.no)).size, 2, '并发报损必须分配不同业务单号')

    const reviewClaim = await api('/api/loss-claims/manual', token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 50 }], reason, description: '并发审核验证' }),
    })
    assert.equal(reviewClaim.status, 201, JSON.stringify(reviewClaim.body))
    assert.equal(reviewClaim.body.status, 'PENDING')
    createdClaimIds.push(reviewClaim.body.id)
    for (const body of [
      null,
      { action: 'reject', note: {} },
      { action: 'approve', note: 'x'.repeat(501) },
      { action: 'approve', unexpected: true },
    ]) {
      const invalidReview = await api(`/api/loss-claims/${reviewClaim.body.id}/manual-review`, reviewerLogin.body.token, {
        method: 'PATCH', body: JSON.stringify(body),
      })
      assert.equal(invalidReview.status, 400, '畸形店内报损审核请求必须稳定返回 400')
    }
    assert.equal((await prisma.lossClaim.findUniqueOrThrow({ where: { id: reviewClaim.body.id } })).status, 'PENDING')
    const reviewResults = await Promise.all(['approve', 'reject'].map(action => api(`/api/loss-claims/${reviewClaim.body.id}/manual-review`, reviewerLogin.body.token, {
      method: 'PATCH', body: JSON.stringify({ action, note: `并发${action}` }),
    })))
    assert.deepEqual(reviewResults.map(result => result.status).sort(), [200, 409], '并发审核只能有一个终态生效')
    const reviewed = await prisma.lossClaim.findUniqueOrThrow({ where: { id: reviewClaim.body.id }, select: { status: true } })
    assert.ok(['APPROVED', 'REJECTED'].includes(reviewed.status))

    const estimate = await estimatedStoreInventory(tenant.id, store.id)
    const row = estimate.items.find(item => item.id === product.id)
    assert.ok(row)
    const expectedStock = reviewed.status === 'APPROVED' ? 66 : 116
    assert.equal(Number(row.stock), expectedStock, '预计库存必须只反映唯一生效的审核终态')
    assert.ok(Math.abs(Number(row.avgUnitCost) - (1300 / 120)) < 0.0001)
    const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: { stock: true } })
    assert.equal(Number(unchanged.stock), 50, '店内报损不能修改供应商库存')
    console.log(JSON.stringify({ ok: true, amountBounds: true, claims: createdClaimIds.length, uniqueNos: 4, authoritativeCost: 10.83, reviewStatus: reviewed.status, estimatedStock: row.stock }))
  } finally {
    if (failureTriggerInstalled) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON op_logs`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }
    await prisma.$transaction(async tx => {
      await tx.notification.deleteMany({ where: { refId: { in: createdClaimIds } } })
      await tx.opLog.deleteMany({ where: { targetId: { in: createdClaimIds } } })
      await tx.lossClaim.deleteMany({ where: { id: { in: createdClaimIds } } })
      await tx.receipt.delete({ where: { id: receipt.id } })
      await tx.inventorySnapshot.delete({ where: { id: snapshot.id } })
      await tx.product.deleteMany({ where: { id: { in: [product.id, unmappedProduct.id, highCostProduct.id] } } })
      await tx.opLog.deleteMany({ where: { userId: reviewer.id, createdAt: { gte: startedAt } } })
      await tx.user.delete({ where: { id: reviewer.id } })
      await tx.product.delete({ where: { id: foreignProduct.id } })
      await tx.tenant.delete({ where: { id: foreignTenant.id } })
    })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
