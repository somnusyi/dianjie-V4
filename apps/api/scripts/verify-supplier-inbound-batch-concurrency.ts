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
    throw new Error('安全护栏：供应商入库批次并发验证仅允许本地 PREVIEW_MODE 隔离库')
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

async function main() {
  assertLocalOnly()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const supplier = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LOCAL-STOCK-VERIFY' } },
    update: { status: 'ENABLED' },
    create: { tenantId: tenant.id, no: 'LOCAL-STOCK-VERIFY', name: '本地库存并发验证供应商', status: 'ENABLED' },
  })
  const password = await bcrypt.hash(PASSWORD, 10)
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: IDENTIFIER } },
    update: { password, role: 'SUPPLIER_OWNER', status: 'ACTIVE', supplierId: supplier.id },
    create: {
      tenantId: tenant.id, supplierId: supplier.id, name: '本地库存并发验证账号',
      email: IDENTIFIER, password, role: 'SUPPLIER_OWNER', status: 'ACTIVE',
    },
  })
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId: supplier.id, code: `STOCK-BATCH-${suffix}`,
      name: `入库批次并发验证品-${suffix}`, unit: '件', price: 1, stock: 0, status: 'ENABLED',
    },
  })

  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token as string

    const duplicateBatchNo = `DUP-${suffix}`
    const duplicateInRequest = await api('/api/supplier/stock/inbound', token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          { productId: product.id, qty: 1, batchNo: duplicateBatchNo },
          { productId: product.id, qty: 1, batchNo: ` ${duplicateBatchNo} ` },
        ],
      }),
    })
    assert.equal(duplicateInRequest.status, 400, JSON.stringify(duplicateInRequest.body))
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock), 0)

    const batchNo = `RACE-${suffix}`
    const payload = JSON.stringify({ items: [{ productId: product.id, qty: 1, batchNo }] })
    const attempts = await Promise.all([1, 2].map(() => api('/api/supplier/stock/inbound', token, {
      method: 'POST', body: payload,
    })))
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409])
    const replay = await api('/api/supplier/stock/inbound', token, { method: 'POST', body: payload })
    assert.equal(replay.status, 409, JSON.stringify(replay.body))
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock), 1)
    assert.equal(await prisma.supplierStockMovement.count({ where: { productId: product.id } }), 1)
    assert.equal(await prisma.supplierStockBatch.count({ where: { productId: product.id, batchNo } }), 1)

    console.log(JSON.stringify({
      ok: true,
      duplicateRequestRejected: true,
      concurrentStatuses: attempts.map(result => result.status).sort(),
      replayStatus: replay.status,
      stock: 1,
      movements: 1,
      batches: 1,
    }))
  } finally {
    await prisma.$transaction(async tx => {
      await tx.supplierStockBatchAllocation.deleteMany({ where: { productId: product.id } })
      await tx.supplierStockBatch.deleteMany({ where: { productId: product.id } })
      await tx.supplierStockMovement.deleteMany({ where: { productId: product.id } })
      await tx.product.delete({ where: { id: product.id } })
    })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
