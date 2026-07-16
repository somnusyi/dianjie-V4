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
    throw new Error('安全护栏: 门店库存验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `INV-${suffix}`,
      name: `库存验证食材-${suffix}`, unit: 'kg', price: 12, stock: 50, minStock: 10, shelfDays: 7,
    },
  })
  const snapshot = await prisma.inventorySnapshot.create({
    data: {
      tenantId: tenant.id, storeId: store.id, snapshotDate: new Date('2026-07-14T00:00:00.000Z'),
      sourceFilename: '自动化库存验证.xlsx', sourceHash: `verify-${suffix}`,
      totalValue: 1000, itemCount: 1, nonzeroCount: 1, zeroCount: 0, matchedCount: 1,
      items: {
        create: [{ productId: product.id, section: '验证', rawName: product.name, unit: 'kg', quantity: 100, unitPrice: 10, amount: 1000, sortOrder: 1 }],
      },
    },
  })
  const receipt = await prisma.receipt.create({
    data: {
      tenantId: tenant.id, no: `RKVERIFY${suffix}`, storeId: store.id, supplierId: supplier.id,
      deliveryDate: new Date('2026-07-15T00:00:00.000Z'), totalAmount: 300,
      status: 'CONFIRMED', isManual: true, confirmedAt: new Date(), createdById: manager.id,
      items: {
        create: [{
          productId: product.id, quantity: 20, unitPrice: 15, amount: 300,
          productionDate: new Date('2026-07-15T00:00:00.000Z'), expiryDate: new Date('2026-07-22T00:00:00.000Z'),
        }],
      },
    },
  })
  const secondProduct = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `INV2-${suffix}`,
      name: `库存原子验证食材-${suffix}`, unit: 'kg', price: 8, stock: 20,
    },
  })
  const foreignTenant = await prisma.tenant.create({ data: { name: `库存边界验证-${suffix}`, slug: `inventory-boundary-${suffix.toLowerCase()}` } })
  const foreignProduct = await prisma.product.create({
    data: { tenantId: foreignTenant.id, code: `FOREIGN-${suffix}`, name: '跨租户库存食材', unit: 'kg', price: 99 },
  })
  const password = await bcrypt.hash(PASSWORD, 10)
  const [supplierUser, unboundKitchenLead] = await Promise.all([
    prisma.user.create({
      data: { tenantId: tenant.id, name: '库存权限验证供应商', email: `inventory-supplier-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER', supplierId: supplier.id },
    }),
    prisma.user.create({
      data: { tenantId: tenant.id, name: '未绑定门店厨师长', email: `inventory-unbound-${suffix}@local.test`, password, role: 'KITCHEN_LEAD' },
    }),
  ])
  let operationId: string | null = null
  const failureFunction = `local_inventory_fail_${suffix.toLowerCase()}`
  const failureTrigger = `local_inventory_trigger_${suffix.toLowerCase()}`
  let failureTriggerInstalled = false
  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST', body: JSON.stringify({ identifier: manager.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const [supplierLogin, unboundLogin] = await Promise.all([
      api('/api/auth/login', null, {
        method: 'POST', body: JSON.stringify({ identifier: supplierUser.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
      }),
      api('/api/auth/login', null, {
        method: 'POST', body: JSON.stringify({ identifier: unboundKitchenLead.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
      }),
    ])
    assert.equal(supplierLogin.status, 200)
    assert.equal(unboundLogin.status, 200)
    assert.equal((await api('/api/inventory', supplierLogin.body.token)).status, 403, '供应商不能查看门店库存')
    assert.equal((await api('/api/inventory/consumptions', supplierLogin.body.token)).status, 403, '供应商不能查看全租户消耗')
    assert.equal((await api('/api/inventory/consumptions', unboundLogin.body.token)).status, 400, '未绑定门店的门店角色不能退化为全租户查询')
    assert.equal((await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: -1 }] }),
    })).status, 400)
    assert.equal((await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }, { productId: product.id, quantity: 2 }] }),
    })).status, 400, '同一食材不能重复提交')
    assert.equal((await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ date: '2026-07-17', items: [{ productId: product.id, quantity: 1 }] }),
    })).status, 400, '不能录入未来消耗')
    assert.equal((await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ items: [{ productId: product.id, quantity: 0.1234567 }] }),
    })).status, 400, '数量精度不能超过库存消耗字段的 6 位小数')
    const crossTenant = await api('/api/inventory/consume', login.body.token, {
      method: 'POST',
      body: JSON.stringify({ note: '跨租户不得部分写入', items: [{ productId: product.id, quantity: 1 }, { productId: foreignProduct.id, quantity: 1 }] }),
    })
    assert.equal(crossTenant.status, 400)
    assert.equal(await prisma.stockConsumption.count({ where: { note: '跨租户不得部分写入' } }), 0)

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${failureFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."productId" = '${secondProduct.id}' THEN RAISE EXCEPTION 'local inventory failure injection'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${failureTrigger}" BEFORE INSERT ON stock_consumptions
      FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
    `)
    failureTriggerInstalled = true
    const failedBatch = await api('/api/inventory/consume', login.body.token, {
      method: 'POST',
      body: JSON.stringify({ note: '库存事务故障注入', items: [{ productId: product.id, quantity: 1 }, { productId: secondProduct.id, quantity: 1 }] }),
    })
    assert.equal(failedBatch.status, 500)
    assert.equal(await prisma.stockConsumption.count({ where: { note: '库存事务故障注入' } }), 0, '批量消耗必须整体回滚')
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON stock_consumptions`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    failureTriggerInstalled = false

    const consumed = await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ date: '2026-07-15', note: '自动化验证', items: [{ productId: product.id, quantity: 15 }] }),
    })
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body))
    operationId = consumed.body.operationId
    const consumption = await prisma.stockConsumption.findFirstOrThrow({
      where: { tenantId: tenant.id, storeId: store.id, productId: product.id, note: '自动化验证' },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(consumption.sourceType, 'manual')
    assert.equal(consumption.sourceId, operationId)

    const estimate = await estimatedStoreInventory(tenant.id, store.id)
    const row = estimate.items.find(item => item.id === product.id)
    assert.ok(row, '验证食材必须出现在预计库存')
    assert.equal(Number(row.stock), 105)
    assert.ok(Math.abs(Number(row.avgUnitCost) - (1300 / 120)) < 0.0001)
    assert.ok(Math.abs(Number(row.inventoryValue) - 1137.5) < 0.001)
    const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: { stock: true } })
    assert.equal(Number(unchanged.stock), 50, '门店消耗不得修改供应商库存 Product.stock')
    console.log(JSON.stringify({ ok: true, opening: 100, inbound: 20, consumption: 15, estimated: row.stock, avgUnitCost: row.avgUnitCost }))
  } finally {
    if (failureTriggerInstalled) {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON stock_consumptions`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`)
    }
    await prisma.$transaction(async tx => {
      if (operationId) await tx.opLog.deleteMany({ where: { targetId: operationId } })
      await tx.opLog.deleteMany({ where: { userId: { in: [supplierUser.id, unboundKitchenLead.id] }, createdAt: { gte: startedAt } } })
      await tx.stockConsumption.deleteMany({ where: { productId: { in: [product.id, secondProduct.id] }, createdAt: { gte: startedAt } } })
      await tx.receipt.deleteMany({ where: { id: receipt.id } })
      await tx.inventorySnapshot.deleteMany({ where: { id: snapshot.id } })
      await tx.product.deleteMany({ where: { id: { in: [product.id, secondProduct.id] } } })
      await tx.user.deleteMany({ where: { id: { in: [supplierUser.id, unboundKitchenLead.id] } } })
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
