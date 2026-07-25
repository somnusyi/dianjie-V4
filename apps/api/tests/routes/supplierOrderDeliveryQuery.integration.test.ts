import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { deliveryRoutes } from '../../src/routes/deliveries'

const suffix = `supplier-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierAId = ''
let supplierBId = ''
let storeId = ''
let chefUserId = ''
let supplierAUserId = ''
let supplierBUserId = ''
let productAId = ''
let productBId = ''
let orderA: any
let orderAId = ''
let orderBId = ''
let deliveryAId = ''
let app: ReturnType<typeof Fastify>

describe('supplier order and delivery list query (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `供应商查询测试 ${suffix}`, slug: suffix },
    })
    tenantId = tenant.id

    const [supplierA, supplierB, store] = await Promise.all([
      prisma.supplier.create({ data: { tenantId, no: `A-${suffix}`, name: '查询供应商 A' } }),
      prisma.supplier.create({ data: { tenantId, no: `B-${suffix}`, name: '查询供应商 B' } }),
      prisma.store.create({ data: { tenantId, no: `S-${suffix}`, name: '查询测试门店' } }),
    ])
    supplierAId = supplierA.id
    supplierBId = supplierB.id
    storeId = store.id

    const [chef, supplierAUser, supplierBUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '查询厨师长', email: `chef-${suffix}@local.test`,
          password: 'test-only', role: 'KITCHEN_LEAD',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, supplierId: supplierAId, name: '查询供应商 A 账号', email: `a-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, supplierId: supplierBId, name: '查询供应商 B 账号', email: `b-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
    ])
    chefUserId = chef.id
    supplierAUserId = supplierAUser.id
    supplierBUserId = supplierBUser.id

    const [productA, productB] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId: supplierAId, code: `A-CODE-${suffix}`, name: `A商品-${suffix}`,
          category: '菌菇', unit: '斤', price: 10, stock: 100, minOrderQty: 1, stepQty: 1,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId: supplierBId, code: `B-CODE-${suffix}`, name: `B商品-${suffix}`,
          category: '蔬菜', unit: 'kg', price: 20, stock: 100, minOrderQty: 1, stepQty: 1,
        },
      }),
    ])
    productAId = productA.id
    productBId = productB.id

    const orderDate = new Date('2026-07-15T08:00:00.000Z')
    const [orderACreated, orderB] = await Promise.all([
      prisma.purchaseOrder.create({
        data: {
          tenantId, no: `PO-A-${suffix}`, storeId, supplierId: supplierAId,
          expectedDate: orderDate, totalAmount: 100, status: 'SUBMITTED',
          createdById: chefUserId, createdAt: orderDate,
          items: {
            create: {
              productId: productAId, quantity: 10, unitPrice: 10, amount: 100,
            },
          },
        },
        include: { items: true },
      }),
      prisma.purchaseOrder.create({
        data: {
          tenantId, no: `PO-B-${suffix}`, storeId, supplierId: supplierBId,
          expectedDate: orderDate, totalAmount: 200, status: 'CONFIRMED',
          createdById: chefUserId, createdAt: new Date('2026-07-20T08:00:00.000Z'),
          items: {
            create: {
              productId: productBId, quantity: 10, unitPrice: 20, amount: 200,
            },
          },
        },
        include: { items: true },
      }),
    ])
    orderA = orderACreated
    orderAId = orderACreated.id
    orderBId = orderB.id
    await prisma.purchaseOrder.update({
      where: { id: orderAId },
      data: {
        submittedSnapshot: {
          items: [{
            productId: productAId,
            name: `A商品-${suffix}`,
            code: `A-CODE-${suffix}`,
            quantity: '10.00',
            unitPrice: '10.00',
          }],
        },
      },
    })

    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-A-${suffix}`, purchaseOrderId: orderAId, storeId, supplierId: supplierAId,
        status: 'SHIPPED', actualTotalAmount: 100, createdById: supplierAUserId,
        createdAt: orderDate, shippedById: supplierAUserId, shippedAt: orderDate,
        items: {
          create: {
            purchaseOrderItemId: orderA.items[0].id, productId: productAId,
            orderedQtySnapshot: 10, shippedQty: 10, unitPriceSnapshot: 10, amount: 100,
            productCodeSnapshot: `A-CODE-${suffix}`, productNameSnapshot: `A商品-${suffix}`,
          },
        },
      },
    })
    deliveryAId = delivery.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'chef')
      request.user = actor === 'supplierA'
        ? { tenantId, supplierId: supplierAId, userId: supplierAUserId, role: 'SUPPLIER_OWNER' }
        : actor === 'supplierB'
          ? { tenantId, supplierId: supplierBId, userId: supplierBUserId, role: 'SUPPLIER_OWNER' }
          : { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
    })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('lists purchase orders with tenant + supplier isolation', async () => {
    const aList = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(aList.statusCode).toBe(200)
    const aJson = aList.json()
    expect(aJson.items.map((o: any) => o.id)).toEqual([orderAId])
    expect(aJson.total).toBe(1)

    const bList = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierB' },
    })
    expect(bList.statusCode).toBe(200)
    expect(bList.json().items.map((o: any) => o.id)).toEqual([orderBId])
  })

  it('filters purchase orders by date range', async () => {
    const matched = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-15&dateTo=2026-07-16&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(matched.statusCode).toBe(200)
    expect(matched.json().items.map((o: any) => o.id)).toEqual([orderAId])

    const empty = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-01&dateTo=2026-07-14&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().items).toHaveLength(0)
    expect(empty.json().total).toBe(0)

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/orders?dateFrom=2026-07-20&dateTo=2026-07-15&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('filters purchase orders by product name / code keyword', async () => {
    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/orders?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((o: any) => o.id)).toEqual([orderAId])
    }

    const noMatch = await app.inject({
      method: 'GET',
      url: `/api/orders?keyword=${encodeURIComponent(`B商品-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(noMatch.statusCode).toBe(200)
    expect(noMatch.json().items).toHaveLength(0)
  })

  it('keeps purchase orders searchable by the first-submission snapshot after product rename', async () => {
    await prisma.product.update({
      where: { id: productAId },
      data: { name: `A商品-已改名-${suffix}`, code: `A-CODE-NEW-${suffix}` },
    })

    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/orders?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((order: any) => order.id)).toEqual([orderAId])
    }

    const currentName = await app.inject({
      method: 'GET',
      url: `/api/orders?keyword=${encodeURIComponent(`A商品-已改名-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(currentName.statusCode).toBe(200)
    expect(currentName.json().items.map((order: any) => order.id)).toEqual([orderAId])
  })

  it('paginates purchase orders server-side', async () => {
    const first = await app.inject({
      method: 'GET', url: '/api/orders?page=1&pageSize=1', headers: { 'x-test-actor': 'chef' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(1)
    expect(first.json().total).toBe(2)

    const second = await app.inject({
      method: 'GET', url: '/api/orders?page=2&pageSize=1', headers: { 'x-test-actor': 'chef' },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().items).toHaveLength(1)
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id)
  })

  it('lists delivery orders with tenant + supplier isolation', async () => {
    const aList = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(aList.statusCode).toBe(200)
    expect(aList.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const bList = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplierB' },
    })
    expect(bList.statusCode).toBe(200)
    expect(bList.json().items).toHaveLength(0)
  })

  it('filters delivery orders by date range and status', async () => {
    const matched = await app.inject({
      method: 'GET',
      url: `/api/deliveries?dateFrom=2026-07-15&dateTo=2026-07-16&status=SHIPPED&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(matched.statusCode).toBe(200)
    expect(matched.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const wrongStatus = await app.inject({
      method: 'GET',
      url: `/api/deliveries?status=DELIVERED&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(wrongStatus.statusCode).toBe(200)
    expect(wrongStatus.json().items).toHaveLength(0)
  })

  it('filters delivery orders by product keyword and snapshot after rename', async () => {
    for (const keyword of [`A商品-${suffix}`, `A-CODE-${suffix}`]) {
      const beforeRename = await app.inject({
        method: 'GET',
        url: `/api/deliveries?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
        headers: { 'x-test-actor': 'supplierA' },
      })
      expect(beforeRename.statusCode).toBe(200)
      expect(beforeRename.json().items.map((d: any) => d.id)).toEqual([deliveryAId])
    }

    await prisma.product.update({
      where: { id: productAId },
      data: { name: `A商品-已改名-${suffix}`, code: `A-CODE-NEW-${suffix}` },
    })

    const bySnapshotName = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A商品-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(bySnapshotName.statusCode).toBe(200)
    expect(bySnapshotName.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const bySnapshotCode = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A-CODE-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(bySnapshotCode.statusCode).toBe(200)
    expect(bySnapshotCode.json().items.map((d: any) => d.id)).toEqual([deliveryAId])

    const byNewName = await app.inject({
      method: 'GET',
      url: `/api/deliveries?keyword=${encodeURIComponent(`A商品-已改名-${suffix}`)}&page=1&pageSize=20`,
      headers: { 'x-test-actor': 'supplierA' },
    })
    expect(byNewName.statusCode).toBe(200)
    expect(byNewName.json().items.map((d: any) => d.id)).toEqual([deliveryAId])
  })

  it('paginates delivery orders server-side', async () => {
    const secondDelivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-A-2-${suffix}`, purchaseOrderId: orderAId, storeId, supplierId: supplierAId,
        status: 'SHIPPED', actualTotalAmount: 50, createdById: supplierAUserId,
        createdAt: new Date('2026-07-16T08:00:00.000Z'), shippedById: supplierAUserId, shippedAt: new Date(),
        items: {
          create: {
            purchaseOrderItemId: orderA.items[0].id, productId: productAId,
            orderedQtySnapshot: 10, shippedQty: 5, unitPriceSnapshot: 10, amount: 50,
            productCodeSnapshot: `A-CODE-${suffix}`, productNameSnapshot: `A商品-${suffix}`,
          },
        },
      },
    })

    const first = await app.inject({
      method: 'GET', url: '/api/deliveries?page=1&pageSize=1', headers: { 'x-test-actor': 'supplierA' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toHaveLength(1)
    expect(first.json().total).toBe(2)

    await prisma.deliveryOrder.delete({ where: { id: secondDelivery.id } })
  })
})
