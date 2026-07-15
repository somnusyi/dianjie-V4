import 'dotenv/config'
import assert from 'node:assert/strict'
import { prisma } from '@dianjie/db'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const IDENTIFIER = 'supplier-delivery-verify@local.test'
const PASSWORD = 'yaohai@123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏：商品管理验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function main() {
  assertLocalOnly()
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const user = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: IDENTIFIER, supplierId: { not: null } },
  })
  const supplierId = user.supplierId!
  const categoryNames = ['验证分类A', '验证分类B', '验证分类C']
  for (let index = 0; index < categoryNames.length; index++) {
    await prisma.supplierProductCategory.upsert({
      where: { tenantId_supplierId_name: { tenantId: tenant.id, supplierId, name: categoryNames[index] } },
      create: { tenantId: tenant.id, supplierId, name: categoryNames[index], sortOrder: 900 + index },
      update: { isActive: true },
    })
  }
  const code = `VERIFY-SKU-${Date.now()}`
  const products = await Promise.all([
    { code, name: '本地商品管理验证品' },
    { code: `${code}-B`, name: '并发停售验证品 B' },
    { code: `${code}-C`, name: '并发停售验证品 C' },
  ].map(item => prisma.product.create({
    data: {
      tenantId: tenant.id, supplierId, code: item.code,
      name: item.name, spec: '1kg/件', category: '验证分类A', unit: '件',
      price: 10, stock: 0, minStock: 0, status: 'ENABLED',
    },
  })))
  const [product, productB, productC] = products
  const documentIds: string[] = []

  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token as string

    const categories = await api('/api/products/categories', token)
    assert.equal(categories.status, 200, JSON.stringify(categories.body))
    assert.ok(categories.body.some((item: any) => item.name === '验证分类A'))

    const patch = await api(`/api/products/${product.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ category: '验证分类B', imageKey: `products/${tenant.id}/verify.jpg` }),
    })
    assert.equal(patch.status, 200, JSON.stringify(patch.body))
    assert.equal(patch.body.product.category, '验证分类B')

    const batchCategory = await api('/api/products/batch-category', token, {
      method: 'PATCH',
      body: JSON.stringify({ ids: [product.id], category: '验证分类C' }),
    })
    assert.equal(batchCategory.status, 200, JSON.stringify(batchCategory.body))
    assert.equal(batchCategory.body.count, 1)

    const independentDisable = await Promise.all([
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [productB.id], status: 'DISABLED' }),
      }),
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [productC.id], status: 'DISABLED' }),
      }),
    ])
    independentDisable.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)))
    assert.notEqual(independentDisable[0].body.documentNo, independentDisable[1].body.documentNo, '并发审批单号必须唯一')
    const independentDocs = await prisma.document.findMany({
      where: { tenantId: tenant.id, no: { in: independentDisable.map(result => result.body.documentNo) } },
    })
    assert.equal(independentDocs.length, 2)
    documentIds.push(...independentDocs.map(doc => doc.id))

    const duplicateDisable = await Promise.all([
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [product.id], status: 'DISABLED' }),
      }),
      api('/api/products/batch-status', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [product.id], status: 'DISABLED' }),
      }),
    ])
    const successfulDisable = duplicateDisable.filter(result => result.status === 200)
    const rejectedDisable = duplicateDisable.filter(result => result.status === 400 || result.status === 409)
    assert.equal(successfulDisable.length, 1, JSON.stringify(duplicateDisable))
    assert.equal(rejectedDisable.length, 1, JSON.stringify(duplicateDisable))
    const duplicateDoc = await prisma.document.findFirstOrThrow({
      where: { tenantId: tenant.id, no: successfulDisable[0].body.documentNo },
    })
    documentIds.push(duplicateDoc.id)
    assert.equal(await prisma.document.count({
      where: {
        tenantId: tenant.id, status: 'PENDING',
        payload: { path: ['productIds'], array_contains: [product.id] },
      },
    }), 1, '重复停售只能生成一张待审批单')
    const pendingProducts = await prisma.product.findMany({
      where: { id: { in: products.map(item => item.id) } }, select: { status: true },
    })
    assert.ok(pendingProducts.every(item => item.status === 'PENDING_DISABLE'))

    const history = await api('/api/products/history?limit=100', token)
    assert.equal(history.status, 200, JSON.stringify(history.body))
    assert.ok(history.body.some((row: any) => row.targetId === product.id || row.action.includes('批量')))

    const clearAll = await api('/api/products/clear-all', token, {
      method: 'DELETE', body: JSON.stringify({ confirm: 'CLEAR_ALL' }),
    })
    assert.equal(clearAll.status, 410)

    console.log(JSON.stringify({
      ok: true,
      categoryFilter: true,
      imageKey: true,
      batchCategory: true,
      batchDisableApproval: true,
      concurrentDocumentNumbers: true,
      duplicateDisableRejected: true,
      auditHistory: true,
      destructiveClearBlocked: true,
    }))
  } finally {
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id, userId: user.id, createdAt: { gte: startedAt },
        entityType: { in: ['Product', 'ProductBatch', 'ProductCategory'] },
      },
    })
    if (documentIds.length) await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
    await prisma.product.deleteMany({ where: { id: { in: products.map(item => item.id) } } })
    await prisma.supplierProductCategory.deleteMany({
      where: { tenantId: tenant.id, supplierId, name: { in: categoryNames } },
    })
  }
}

main().finally(() => prisma.$disconnect())
