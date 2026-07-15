import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const IDENTIFIER = 'supplier-stock-verify@local.test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏：供应商库存并发验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

function sortedBalances(rows: any[]) {
  return rows.map(row => Number(row.balanceAfter)).sort((a, b) => a - b)
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LOCAL-STOCK-VERIFY' } },
    update: { status: 'ENABLED' },
    create: { tenantId: tenant.id, no: 'LOCAL-STOCK-VERIFY', name: '本地库存并发验证供应商', status: 'ENABLED' },
  })
  const password = await bcrypt.hash(PASSWORD, 10)
  const user = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: IDENTIFIER } },
    update: { password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
    create: {
      tenantId: tenant.id,
      name: '本地库存并发验证账号',
      email: IDENTIFIER,
      password,
      role: 'SUPPLIER_OWNER',
      status: 'ACTIVE',
      supplierId: supplier.id,
    },
  })
  const categoryName = `并发验证-${suffix}`
  await prisma.supplierProductCategory.create({
    data: { tenantId: tenant.id, supplierId: supplier.id, name: categoryName, sortOrder: 990 },
  })
  const products = await Promise.all([1, 2].map(index => prisma.product.create({
    data: {
      tenantId: tenant.id,
      supplierId: supplier.id,
      code: `STOCK-RACE-${suffix}-${index}`,
      name: `库存并发验证品-${suffix}-${index}`,
      category: categoryName,
      unit: '件',
      price: 1,
      stock: 10,
      status: 'ENABLED',
    },
  })))
  const [productA, productB] = products

  const foreignTenant = await prisma.tenant.create({
    data: { name: `库存隔离验证-${suffix}`, slug: `stock-boundary-${suffix}` },
  })
  const foreignSupplier = await prisma.supplier.create({
    data: { tenantId: foreignTenant.id, no: 'FOREIGN-STOCK', name: '跨租户验证供应商' },
  })
  const foreignUser = await prisma.user.create({
    data: {
      tenantId: foreignTenant.id,
      name: '跨租户验证账号',
      email: `foreign-stock-${suffix}@local.test`,
      password,
      role: 'SUPPLIER_OWNER',
      supplierId: foreignSupplier.id,
    },
  })
  const foreignProduct = await prisma.product.create({
    data: {
      tenantId: foreignTenant.id,
      supplierId: foreignSupplier.id,
      code: 'FOREIGN-STOCK-A',
      name: '跨租户库存验证品',
      unit: '件',
      price: 1,
      stock: 1,
    },
  })
  await prisma.supplierStockMovement.create({
    data: {
      tenantId: foreignTenant.id,
      supplierId: foreignSupplier.id,
      productId: foreignProduct.id,
      delta: 1,
      balanceAfter: 1,
      type: 'INITIAL',
      sourceType: 'Test',
      createdById: foreignUser.id,
    },
  })

  const reset = async (stockA = 10, stockB = 10) => {
    await prisma.supplierStockMovement.deleteMany({ where: { productId: { in: products.map(product => product.id) } } })
    await prisma.product.update({ where: { id: productA.id }, data: { stock: stockA } })
    await prisma.product.update({ where: { id: productB.id }, data: { stock: stockB } })
  }

  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token as string

    const foreignInbound = await api('/api/supplier/stock/inbound', token, {
      method: 'POST',
      body: JSON.stringify({ items: [{ productId: foreignProduct.id, qty: 1 }] }),
    })
    assert.equal(foreignInbound.status, 400, '跨租户商品不得入库')
    const foreignMovements = await api(`/api/supplier/stock/movements?productId=${foreignProduct.id}`, token)
    assert.equal(foreignMovements.status, 200)
    assert.deepEqual(foreignMovements.body, [], '跨租户库存流水不得泄漏')

    await reset()
    const concurrentInbound = await Promise.all([
      api('/api/supplier/stock/inbound', token, {
        method: 'POST', body: JSON.stringify({ items: [{ productId: productA.id, qty: 5 }], reason: '并发入库 A' }),
      }),
      api('/api/supplier/stock/inbound', token, {
        method: 'POST', body: JSON.stringify({ items: [{ productId: productA.id, qty: 7 }], reason: '并发入库 B' }),
      }),
    ])
    concurrentInbound.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stock), 22)
    const inboundMovements = (await api(`/api/supplier/stock/movements?productId=${productA.id}`, token)).body
    assert.equal(inboundMovements.length, 2)
    assert.equal(inboundMovements.reduce((sum: number, row: any) => sum + Number(row.delta), 0), 12)
    assert.ok(inboundMovements.some((row: any) => Number(row.balanceAfter) === 22))

    await reset()
    const inboundAndLoss = await Promise.all([
      api('/api/supplier/stock/inbound', token, {
        method: 'POST', body: JSON.stringify({ items: [{ productId: productA.id, qty: 3 }], reason: '并发入库与报损' }),
      }),
      api('/api/supplier/stock/loss', token, {
        method: 'POST', body: JSON.stringify({ productId: productA.id, qty: 4, reason: '并发报损验证' }),
      }),
    ])
    inboundAndLoss.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stock), 9)
    const lossMovements = (await api(`/api/supplier/stock/movements?productId=${productA.id}`, token)).body
    assert.ok([
      JSON.stringify([6, 9]),
      JSON.stringify([9, 13]),
    ].includes(JSON.stringify(sortedBalances(lossMovements))))

    await reset()
    const inverseBatches = await Promise.all([
      api('/api/supplier/stock/inbound', token, {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: productA.id, qty: 1 }, { productId: productB.id, qty: 1 }] }),
      }),
      api('/api/supplier/stock/inbound', token, {
        method: 'POST',
        body: JSON.stringify({ items: [{ productId: productB.id, qty: 2 }, { productId: productA.id, qty: 2 }] }),
      }),
    ])
    inverseBatches.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    const inverseProducts = await prisma.product.findMany({ where: { id: { in: products.map(product => product.id) } } })
    assert.deepEqual(inverseProducts.map(product => Number(product.stock)).sort(), [13, 13])

    await reset()
    const adjustAndInbound = await Promise.all([
      api('/api/supplier/stock/adjust', token, {
        method: 'POST', body: JSON.stringify({ productId: productA.id, newQty: 20, reason: '并发盘点验证' }),
      }),
      api('/api/supplier/stock/inbound', token, {
        method: 'POST', body: JSON.stringify({ items: [{ productId: productA.id, qty: 5 }], reason: '并发盘点与入库' }),
      }),
    ])
    adjustAndInbound.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    const adjustStock = Number((await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stock)
    const adjustMovements = (await api(`/api/supplier/stock/movements?productId=${productA.id}`, token)).body
    assert.ok([20, 25].includes(adjustStock))
    assert.ok([
      JSON.stringify([15, 20]),
      JSON.stringify([20, 25]),
    ].includes(JSON.stringify(sortedBalances(adjustMovements))))

    await reset()
    const snapshotAndInbound = await Promise.all([
      api('/api/supplier/stock/import-snapshot', token, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ name: productA.name, category: categoryName, unit: '件', qty: 20 }],
          reason: '并发快照验证',
        }),
      }),
      api('/api/supplier/stock/inbound', token, {
        method: 'POST', body: JSON.stringify({ items: [{ productId: productA.id, qty: 5 }], reason: '并发快照与入库' }),
      }),
    ])
    snapshotAndInbound.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.equal(snapshotAndInbound[0].body.summary.failed, 0)
    const snapshotStock = Number((await prisma.product.findUniqueOrThrow({ where: { id: productA.id } })).stock)
    const snapshotMovements = (await api(`/api/supplier/stock/movements?productId=${productA.id}`, token)).body
    assert.ok([20, 25].includes(snapshotStock))
    assert.ok([
      JSON.stringify([15, 20]),
      JSON.stringify([20, 25]),
    ].includes(JSON.stringify(sortedBalances(snapshotMovements))))

    console.log(JSON.stringify({
      ok: true,
      crossTenantIsolation: true,
      concurrentInbound: true,
      inboundLossRace: true,
      inverseBatchDeadlockSafe: true,
      adjustRace: true,
      snapshotRace: true,
    }))
  } finally {
    await prisma.supplierStockMovement.deleteMany({ where: { productId: { in: products.map(product => product.id) } } })
    await prisma.product.deleteMany({ where: { id: { in: products.map(product => product.id) } } })
    await prisma.supplierProductCategory.deleteMany({
      where: { tenantId: tenant.id, supplierId: supplier.id, name: categoryName },
    })
    await prisma.supplierStockMovement.deleteMany({ where: { productId: foreignProduct.id } })
    await prisma.product.delete({ where: { id: foreignProduct.id } })
    await prisma.user.delete({ where: { id: foreignUser.id } })
    await prisma.supplier.delete({ where: { id: foreignSupplier.id } })
    await prisma.tenant.delete({ where: { id: foreignTenant.id } })
  }
}

main().finally(() => prisma.$disconnect())
