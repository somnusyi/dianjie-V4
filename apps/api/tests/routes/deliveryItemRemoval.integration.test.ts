import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { deliveryRoutes } from '../../src/routes/deliveries'

const suffix = `delivery-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let supplierUserId = ''
let storeUserId = ''
let productAId = ''
let productBId = ''
let productCId = ''
let orderId = ''
let deliveryId = ''
let itemAId = ''
let itemBId = ''
let itemCId = ''
let app: ReturnType<typeof Fastify>

describe('delivery item removal (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `移除测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id

    const [supplier, store] = await Promise.all([
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '移除测试供应商' } }),
      prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '移除测试门店' } }),
    ])
    supplierId = supplier.id
    storeId = store.id

    const [supplierUser, storeUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, supplierId, name: '移除测试供应商账号', email: `supplier-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '移除测试门店账号', email: `store-${suffix}@local.test`,
          password: 'test-only', role: 'MANAGER',
        },
      }),
    ])
    supplierUserId = supplierUser.id
    storeUserId = storeUser.id

    const [productA, productB, productC] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REMOVE-A-${suffix}`, name: '待移除商品 A',
          unit: 'kg', category: '测试', price: 10, stock: 0,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REMOVE-B-${suffix}`, name: '保留商品 B',
          unit: 'kg', category: '测试', price: 10, stock: 0,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REMOVE-C-${suffix}`, name: '保留商品 C',
          unit: 'kg', category: '测试', price: 10, stock: 0,
        },
      }),
    ])
    productAId = productA.id
    productBId = productB.id
    productCId = productC.id

    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-${suffix}`, storeId, supplierId, expectedDate: new Date('2026-08-31'),
        totalAmount: 40, originalTotalAmount: 40, currentOrderAmount: 40, status: 'DELIVERING',
        createdById: storeUserId,
        items: {
          create: [
            { productId: productAId, quantity: 2, shippedQty: 2, unitPrice: 10, amount: 20 },
            { productId: productBId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
            { productId: productCId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
          ],
        },
      },
      include: { items: true },
    })
    orderId = order.id

    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-${suffix}`, purchaseOrderId: orderId, storeId, supplierId,
        status: 'SHIPPED', actualTotalAmount: 40, createdById: supplierUserId,
        shippedById: supplierUserId, shippedAt: new Date('2026-08-31T01:00:00.000Z'),
        items: {
          create: [
            {
              purchaseOrderItemId: order.items[0].id, productId: productAId,
              orderedQtySnapshot: 2, shippedQty: 2, unitPriceSnapshot: 10, amount: 20,
              productNameSnapshot: '待移除商品 A', productUnitSnapshot: 'kg',
            },
            {
              purchaseOrderItemId: order.items[1].id, productId: productBId,
              orderedQtySnapshot: 1, shippedQty: 1, unitPriceSnapshot: 10, amount: 10,
              productNameSnapshot: '保留商品 B', productUnitSnapshot: 'kg',
            },
            {
              purchaseOrderItemId: order.items[2].id, productId: productCId,
              orderedQtySnapshot: 1, shippedQty: 1, unitPriceSnapshot: 10, amount: 10,
              productNameSnapshot: '保留商品 C', productUnitSnapshot: 'kg',
            },
          ],
        },
      },
      include: { items: true },
    })
    deliveryId = delivery.id
    itemAId = delivery.items.find(item => item.productId === productAId)!.id
    itemBId = delivery.items.find(item => item.productId === productBId)!.id
    itemCId = delivery.items.find(item => item.productId === productCId)!.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supplier')
      request.user = actor === 'store'
        ? { tenantId, storeId, storeIds: [storeId], userId: storeUserId, role: 'MANAGER' }
        : { tenantId, supplierId, userId: supplierUserId, role: 'SUPPLIER_OWNER' }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('soft-removes one item, recalculates totals, and hides it from reads', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supplier' },
      payload: { itemId: itemAId, rowVersion: 0 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, deliveryTotal: '20.00', orderTotal: '20.00' })

    const [delivery, order, removedItem, deliveryList] = await Promise.all([
      prisma.deliveryOrder.findUnique({ where: { id: deliveryId } }),
      prisma.purchaseOrder.findUnique({ where: { id: orderId } }),
      prisma.deliveryOrderItem.findUnique({ where: { id: itemAId } }),
      app.inject({ method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplier' } }),
    ])
    expect(delivery?.actualTotalAmount.toString()).toBe('20')
    expect(delivery?.rowVersion).toBe(1)
    expect(order?.totalAmount.toString()).toBe('20')
    expect(removedItem?.shippedQty.toString()).toBe('0')
    expect(removedItem?.amount.toString()).toBe('0')
    expect(deliveryList.statusCode).toBe(200)
    expect(deliveryList.json().items[0].items.map((item: any) => item.id)).toEqual([itemBId, itemCId])
  })

  it('reverses strict supplier stock and reservation facts atomically', async () => {
    await prisma.supplier.update({ where: { id: supplierId }, data: { inventoryMode: 'STRICT' } })
    await prisma.product.update({ where: { id: productBId }, data: { stock: 9 } })
    const batch = await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId: productBId, batchNo: `OPENING-${suffix}`,
        kind: 'OPENING', initialQty: 10, remainingQty: 9, createdById: supplierUserId,
      },
    })
    const movement = await prisma.supplierStockMovement.create({
      data: {
        tenantId, supplierId, productId: productBId, delta: -1, balanceAfter: 9,
        type: 'OUTBOUND_PO', sourceType: 'DeliveryOrder', sourceId: deliveryId,
        createdById: supplierUserId,
      },
    })
    await prisma.supplierStockBatchAllocation.create({
      data: { tenantId, supplierId, productId: productBId, batchId: batch.id, movementId: movement.id, quantity: 1 },
    })
    const poItemB = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: orderId, productId: productBId } })
    await prisma.supplierStockReservation.create({
      data: {
        tenantId, supplierId, productId: productBId, purchaseOrderId: orderId, purchaseOrderItemId: poItemB.id,
        quantity: 1, fulfilledQty: 1, status: 'CONSUMED', consumedAt: new Date(),
      },
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supplier' },
      payload: { itemId: itemBId, rowVersion: 1 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, deliveryTotal: '10.00', orderTotal: '10.00' })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productBId } })).stock)).toBe(10)
    expect(Number((await prisma.supplierStockBatch.findUniqueOrThrow({ where: { id: batch.id } })).remainingQty)).toBe(10)
    expect(await prisma.supplierStockReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: poItemB.id } })).toMatchObject({ status: 'RELEASED' })
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, sourceType: 'DeliveryOrderItemRemoval' } })).toBe(1)
  })

  it('rejects store-side removal even before receipt', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'store' },
      payload: { itemId: itemCId, rowVersion: 2 },
    })
    expect(response.statusCode).toBe(403)
  })
})
