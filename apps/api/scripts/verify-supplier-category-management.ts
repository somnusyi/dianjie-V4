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
    throw new Error('安全护栏：分类管理验证仅允许本地 PREVIEW_MODE 隔离库')
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
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const user = await prisma.user.findFirstOrThrow({
    where: { tenantId: tenant.id, email: IDENTIFIER, supplierId: { not: null } },
  })
  const supplierId = user.supplierId!
  const suffix = Date.now().toString(36)
  const originalName = `分类验证-${suffix}`
  const renamedName = `分类改名-${suffix}`
  const secondName = `分类排序-${suffix}`
  let categoryId: string | null = null
  let secondId: string | null = null
  let productId: string | null = null

  try {
    const login = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD, tenantSlug: TENANT_SLUG }),
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const token = login.body.token as string

    const created = await api('/api/products/categories', token, {
      method: 'POST', body: JSON.stringify({ name: originalName }),
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    categoryId = created.body.id

    const second = await api('/api/products/categories', token, {
      method: 'POST', body: JSON.stringify({ name: secondName }),
    })
    assert.equal(second.status, 201, JSON.stringify(second.body))
    secondId = second.body.id

    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id, supplierId, code: `CATEGORY-${suffix}`,
        name: '分类联动验证品', category: originalName, unit: '件', price: 10,
        stock: 3, minStock: 1, status: 'ENABLED',
      },
    })
    productId = product.id

    const renamed = await api(`/api/products/categories/${categoryId}`, token, {
      method: 'PATCH', body: JSON.stringify({ name: renamedName }),
    })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).category, renamedName)

    const stock = await api('/api/supplier/stock', token)
    assert.equal(stock.status, 200, JSON.stringify(stock.body))
    assert.equal(stock.body.find((item: any) => item.id === productId)?.category, renamedName)

    const disabled = await api(`/api/products/categories/${categoryId}`, token, {
      method: 'PATCH', body: JSON.stringify({ isActive: false }),
    })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body))
    const blocked = await api('/api/products/batch-category', token, {
      method: 'PATCH', body: JSON.stringify({ ids: [productId], category: renamedName }),
    })
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body))
    const blockedCreate = await api('/api/products', token, {
      method: 'POST', body: JSON.stringify({ name: '停用分类验证品', unit: '件', price: 1, category: renamedName }),
    })
    assert.equal(blockedCreate.status, 400, JSON.stringify(blockedCreate.body))

    const restored = await api(`/api/products/categories/${categoryId}`, token, {
      method: 'PATCH', body: JSON.stringify({ isActive: true }),
    })
    assert.equal(restored.status, 200, JSON.stringify(restored.body))

    const beforeOrder = await api('/api/products/categories', token)
    assert.equal(beforeOrder.status, 200, JSON.stringify(beforeOrder.body))
    const ids = beforeOrder.body.map((row: any) => row.id).filter(Boolean)
    const withoutTest = ids.filter((id: string) => id !== categoryId && id !== secondId)
    const reorderedIds = [...withoutTest, secondId, categoryId]
    const reordered = await api('/api/products/categories-order', token, {
      method: 'PATCH', body: JSON.stringify({ ids: reorderedIds }),
    })
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body))
    const afterOrder = await api('/api/products/categories', token)
    const names = afterOrder.body.map((row: any) => row.name)
    assert.ok(names.indexOf(secondName) < names.indexOf(renamedName))

    const concurrentReorders = await Promise.all([
      api('/api/products/categories-order', token, {
        method: 'PATCH', body: JSON.stringify({ ids: reorderedIds }),
      }),
      api('/api/products/categories-order', token, {
        method: 'PATCH', body: JSON.stringify({ ids: [...reorderedIds].reverse() }),
      }),
    ])
    assert.deepEqual(concurrentReorders.map(result => result.status), [200, 200], '并发分类排序必须串行成功')
    const afterConcurrentOrder = await api('/api/products/categories', token)
    assert.equal(afterConcurrentOrder.status, 200, JSON.stringify(afterConcurrentOrder.body))
    assert.equal(new Set(afterConcurrentOrder.body.map((row: any) => row.sortOrder)).size, afterConcurrentOrder.body.length)

    const history = await api('/api/products/history?limit=100', token)
    assert.equal(history.status, 200, JSON.stringify(history.body))
    assert.ok(history.body.some((row: any) => row.entityType === 'ProductCategory' && row.targetId === categoryId))

    console.log(JSON.stringify({
      ok: true,
      create: true,
      renameUpdatesProductsAndInventory: true,
      disableBlocksAssignment: true,
      disableBlocksNewSku: true,
      restore: true,
      reorder: true,
      concurrentReorder: true,
      auditHistory: true,
    }))
  } finally {
    if (productId) await prisma.product.deleteMany({ where: { id: productId } })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id, userId: user.id, createdAt: { gte: startedAt },
        entityType: 'ProductCategory',
      },
    })
    await prisma.supplierProductCategory.deleteMany({
      where: { tenantId: tenant.id, supplierId, name: { in: [originalName, renamedName, secondName] } },
    })
  }
}

main().finally(() => prisma.$disconnect())
