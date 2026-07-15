import 'dotenv/config'
import assert from 'node:assert/strict'
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
  let consumptionId: string | null = null
  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST', body: JSON.stringify({ identifier: manager.email, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const consumed = await api('/api/inventory/consume', login.body.token, {
      method: 'POST', body: JSON.stringify({ date: '2026-07-15', note: '自动化验证', items: [{ productId: product.id, quantity: 15 }] }),
    })
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body))
    const consumption = await prisma.stockConsumption.findFirstOrThrow({
      where: { tenantId: tenant.id, storeId: store.id, productId: product.id, note: '自动化验证' },
      orderBy: { createdAt: 'desc' },
    })
    consumptionId = consumption.id

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
    await prisma.$transaction(async tx => {
      if (consumptionId) {
        await tx.opLog.deleteMany({ where: { targetId: consumptionId } })
        await tx.stockConsumption.deleteMany({ where: { id: consumptionId } })
      }
      await tx.receipt.deleteMany({ where: { id: receipt.id } })
      await tx.inventorySnapshot.deleteMany({ where: { id: snapshot.id } })
      await tx.product.deleteMany({ where: { id: product.id } })
    })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
