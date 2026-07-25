import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

const suffix = `stock-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let tenantA = ''
let tenantB = ''
let supplierA = ''
let supplierB = ''
let userA = ''
let userB = ''
let productA1 = ''
let productA2 = ''
let productB1 = ''
let app: ReturnType<typeof Fastify>

function actorHeaders(actor: 'ownerA' | 'staffA' | 'ownerB' | 'manager' | 'stranger') {
  const headerMap: Record<string, any> = {
    ownerA: { tenantId: tenantA, supplierId: supplierA, userId: userA, role: 'SUPPLIER_OWNER' },
    staffA: { tenantId: tenantA, supplierId: supplierA, userId: userA, role: 'SUPPLIER_STAFF' },
    ownerB: { tenantId: tenantB, supplierId: supplierB, userId: userB, role: 'SUPPLIER_OWNER' },
    manager: { tenantId: tenantA, storeId: 'store-x', userId: userA, role: 'MANAGER' },
    stranger: { tenantId: 'nonexistent-tenant', supplierId: null, userId: 'stranger', role: 'SUPPLIER_OWNER' },
  }
  return { 'x-test-actor': actor } as Record<string, string>
}

describe('supplier stock routes — isolation & pagination (integration)', () => {
  beforeAll(async () => {
    const [tA, tB] = await Promise.all([
      prisma.tenant.create({ data: { name: `隔离测试 A ${suffix}`, slug: `iso-a-${suffix}` } }),
      prisma.tenant.create({ data: { name: `隔离测试 B ${suffix}`, slug: `iso-b-${suffix}` } }),
    ])
    tenantA = tA.id
    tenantB = tB.id

    const [sA, sB] = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenantA, no: `SUP-A-${suffix}`, name: '隔离供应商 A' } }),
      prisma.supplier.create({ data: { tenantId: tenantB, no: `SUP-B-${suffix}`, name: '隔离供应商 B' } }),
    ])
    supplierA = sA.id
    supplierB = sB.id

    const [uA, uB] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId: tenantA, supplierId: supplierA, name: '供应商 A 测试',
          email: `iso-a-${suffix}@local.test`, password: 'integration-test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId: tenantB, supplierId: supplierB, name: '供应商 B 测试',
          email: `iso-b-${suffix}@local.test`, password: 'integration-test-only', role: 'SUPPLIER_OWNER',
        },
      }),
    ])
    userA = uA.id
    userB = uB.id

    const [pA1, pA2, pB1] = await Promise.all([
      prisma.product.create({ data: { tenantId: tenantA, supplierId: supplierA, code: `A1-${suffix}`, name: '供应商 A 鲜菌', category: '菌菇', price: 10, stock: 5 } }),
      prisma.product.create({ data: { tenantId: tenantA, supplierId: supplierA, code: `A2-${suffix}`, name: '供应商 A 蔬菜', category: '蔬菜', price: 5, stock: 0 } }),
      prisma.product.create({ data: { tenantId: tenantB, supplierId: supplierB, code: `B1-${suffix}`, name: '供应商 B 鲜菌', category: '菌菇', price: 12, stock: 20 } }),
    ])
    productA1 = pA1.id
    productA2 = pA2.id
    productB1 = pB1.id

    await prisma.supplierStockBatch.create({
      data: {
        tenantId: tenantA, supplierId: supplierA, productId: productA1,
        batchNo: `OPENING-A1-${suffix}`, kind: 'OPENING',
        initialQty: 5, remainingQty: 5, createdById: userA,
      },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || '')
      const map: Record<string, any> = {
        ownerA: { tenantId: tenantA, supplierId: supplierA, userId: userA, role: 'SUPPLIER_OWNER' },
        staffA: { tenantId: tenantA, supplierId: supplierA, userId: userA, role: 'SUPPLIER_STAFF' },
        ownerB: { tenantId: tenantB, supplierId: supplierB, userId: userB, role: 'SUPPLIER_OWNER' },
        manager: { tenantId: tenantA, storeId: 'store-x', userId: userA, role: 'MANAGER' },
        stranger: { tenantId: 'nonexistent-tenant', supplierId: null, userId: 'stranger', role: 'SUPPLIER_OWNER' },
      }
      request.user = map[actor] || map.stranger
    })
    await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    for (const tid of [tenantA, tenantB]) {
      await prisma.supplierStockBatch.deleteMany({ where: { tenantId: tid } }).catch(() => {})
      await prisma.supplierStockMovement.deleteMany({ where: { tenantId: tid } }).catch(() => {})
      await prisma.product.deleteMany({ where: { tenantId: tid } }).catch(() => {})
      await prisma.user.deleteMany({ where: { tenantId: tid } }).catch(() => {})
      await prisma.supplier.deleteMany({ where: { tenantId: tid } }).catch(() => {})
      await prisma.tenant.deleteMany({ where: { id: tid } }).catch(() => {})
    }
  })

  it('supplier A sees only their own products, not supplier B', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock', headers: actorHeaders('ownerA') })
    expect(res.statusCode).toBe(200)
    const items = res.json()
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBe(2)
    const ids = new Set(items.map((i: any) => i.id))
    expect(ids.has(productA1)).toBe(true)
    expect(ids.has(productA2)).toBe(true)
    expect(ids.has(productB1)).toBe(false)
  })

  it('supplier B sees only their own products, not supplier A', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock', headers: actorHeaders('ownerB') })
    expect(res.statusCode).toBe(200)
    const items = res.json()
    expect(items.length).toBe(1)
    expect(items[0].id).toBe(productB1)
  })

  it('rejects non-supplier roles (MANAGER) from supplier stock endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock', headers: actorHeaders('manager') })
    expect(res.statusCode).toBe(403)
  })

  it('supplier staff (SUPPLIER_STAFF) can read inventory with same supplier scope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock', headers: actorHeaders('staffA') })
    expect(res.statusCode).toBe(200)
    const items = res.json()
    expect(items.length).toBe(2)
  })

  it('summary is scoped to the authenticated supplier', async () => {
    const resA = await app.inject({ method: 'GET', url: '/api/supplier/stock/summary', headers: actorHeaders('ownerA') })
    expect(resA.statusCode).toBe(200)
    const sumA = resA.json()
    expect(sumA.totalSku).toBe(2)
    expect(sumA.outOfStock).toBe(1)

    const resB = await app.inject({ method: 'GET', url: '/api/supplier/stock/summary', headers: actorHeaders('ownerB') })
    expect(resB.statusCode).toBe(200)
    expect(resB.json().totalSku).toBe(1)
  })

  it('legacy mode: returns plain array when no pagination params', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock', headers: actorHeaders('ownerA') })
    expect(res.statusCode).toBe(200)
    const items = res.json()
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBe(2)
  })

  it('paginated mode: returns envelope with items/total/page/pageSize', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=1&pageSize=10', headers: actorHeaders('ownerA') })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toBeDefined()
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.total).toBe(2)
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(10)
    expect(body.items.length).toBe(2)
  })

  it('paginated mode: page beyond data returns empty items but correct total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=99&pageSize=10', headers: actorHeaders('ownerA') })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toEqual([])
    expect(body.total).toBe(2)
    expect(body.page).toBe(99)
  })

  it('paginated mode: deterministic order is stable across pages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=1&pageSize=1', headers: actorHeaders('ownerA') })
    expect(res.statusCode).toBe(200)
    const page1 = res.json()
    expect(page1.items.length).toBe(1)

    const res2 = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=2&pageSize=1', headers: actorHeaders('ownerA') })
    const page2 = res2.json()
    expect(page2.items.length).toBe(1)
    expect(page1.items[0].id).not.toBe(page2.items[0].id)

    const full = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=1&pageSize=100', headers: actorHeaders('ownerA') })
    const all = full.json().items
    expect(all.length).toBe(2)
    expect(all[0].id).toBe(page1.items[0].id)
    expect(all[1].id).toBe(page2.items[0].id)
  })

  it('paginated mode: tenant/supplier isolation with pagination', async () => {
    const resA = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=1&pageSize=10', headers: actorHeaders('ownerA') })
    expect(resA.statusCode).toBe(200)
    const bodyA = resA.json()
    expect(bodyA.total).toBe(2)
    expect(bodyA.items.length).toBe(2)

    const resB = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=1&pageSize=10', headers: actorHeaders('ownerB') })
    expect(resB.statusCode).toBe(200)
    const bodyB = resB.json()
    expect(bodyB.total).toBe(1)
    expect(bodyB.items.length).toBe(1)
    expect(bodyB.items[0].id).toBe(productB1)
    const idsA = new Set(bodyA.items.map((i: any) => i.id))
    expect(idsA.has(productB1)).toBe(false)
  })

  it('productId filter returns single item in paginated mode', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/supplier/stock?productId=${productA1}&page=1&pageSize=1`,
      headers: actorHeaders('ownerA'),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items.length).toBe(1)
    expect(body.items[0].id).toBe(productA1)
  })

  it('productId filter: supplier cannot query another supplier product', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/supplier/stock?productId=${productB1}&page=1&pageSize=1`,
      headers: actorHeaders('ownerA'),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(0)
    expect(body.items.length).toBe(0)
  })

  it('rejects invalid pagination params', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=0', headers: actorHeaders('ownerA') })
    expect(bad.statusCode).toBe(400)

    const over = await app.inject({ method: 'GET', url: '/api/supplier/stock?pageSize=999', headers: actorHeaders('ownerA') })
    expect(over.statusCode).toBe(400)
  })

  it('movements endpoint is supplier-scoped', async () => {
    const resA = await app.inject({
      method: 'GET', url: `/api/supplier/stock/movements?productId=${productA1}`,
      headers: actorHeaders('ownerA'),
    })
    expect(resA.statusCode).toBe(200)

    const resB = await app.inject({
      method: 'GET', url: `/api/supplier/stock/movements?productId=${productA1}`,
      headers: actorHeaders('ownerB'),
    })
    expect(resB.statusCode).toBe(200)
    expect(resB.json().length).toBe(0)
  })

  it('adjust endpoint rejects cross-supplier productId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/supplier/stock/adjust',
      headers: actorHeaders('ownerA'),
      payload: { productId: productB1, newQty: 10, reason: '跨供应商测试' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('inbound endpoint rejects cross-supplier productId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/supplier/stock/inbound',
      headers: actorHeaders('ownerA'),
      payload: {
        items: [{ productId: productB1, qty: 5 }],
        source: 'MANUAL',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('不属于本供应商')
  })

  it('loss endpoint rejects cross-supplier productId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/supplier/stock/loss',
      headers: actorHeaders('ownerA'),
      payload: { productId: productB1, qty: 1, reason: '跨供应商报损测试' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('batches and reservations endpoints are supplier-scoped', async () => {
    const batchesA = await app.inject({
      method: 'GET', url: `/api/supplier/stock/batches?productId=${productA1}`,
      headers: actorHeaders('ownerA'),
    })
    expect(batchesA.statusCode).toBe(200)
    expect(batchesA.json().length).toBe(1)

    const batchesB = await app.inject({
      method: 'GET', url: `/api/supplier/stock/batches?productId=${productA1}`,
      headers: actorHeaders('ownerB'),
    })
    expect(batchesB.statusCode).toBe(200)
    expect(batchesB.json().length).toBe(0)

    const reservationsA = await app.inject({
      method: 'GET', url: `/api/supplier/stock/reservations?productId=${productA1}`,
      headers: actorHeaders('ownerA'),
    })
    expect(reservationsA.statusCode).toBe(200)
    expect(Array.isArray(reservationsA.json())).toBe(true)
  })
})
