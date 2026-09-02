import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { deliveryRoutes } from '../../src/routes/deliveries'

const suffix = `delivery-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let supplierUserId = ''
let supplyChainUserId = ''
let storeUserId = ''
let productAId = ''
let productBId = ''
let productCId = ''
let productDId = ''
let productEId = ''
let orderId = ''
let deliveryId = ''
let itemAId = ''
let itemBId = ''
let itemCId = ''
let itemDId = ''
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

    const [supplierUser, supplyChainUser, storeUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, supplierId, name: '移除测试供应商账号', email: `supplier-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, name: '移除测试供应链账号', email: `supply-chain-${suffix}@local.test`,
          password: 'test-only', role: 'SUPPLY_CHAIN',
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
    supplyChainUserId = supplyChainUser.id
    storeUserId = storeUser.id

    const [productA, productB, productC, productD, productE] = await Promise.all([
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
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REMOVE-D-${suffix}`, name: '保留商品 D',
          unit: 'kg', category: '测试', price: 10, stock: 0,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REMOVE-E-${suffix}`, name: '新增商品 E',
          unit: 'kg', category: '测试', price: 5, stock: 0,
        },
      }),
    ])
    productAId = productA.id
    productBId = productB.id
    productCId = productC.id
    productDId = productD.id
    productEId = productE.id

    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-${suffix}`, storeId, supplierId, expectedDate: new Date('2026-08-31'),
        totalAmount: 50, originalTotalAmount: 50, currentOrderAmount: 50, status: 'DELIVERING',
        createdById: storeUserId,
        items: {
          create: [
            { productId: productAId, quantity: 2, shippedQty: 2, unitPrice: 10, amount: 20 },
            { productId: productBId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
            { productId: productCId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
            { productId: productDId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
          ],
        },
      },
      include: { items: true },
    })
    orderId = order.id

    const delivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-${suffix}`, purchaseOrderId: orderId, storeId, supplierId,
        status: 'SHIPPED', actualTotalAmount: 50, createdById: supplierUserId,
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
            {
              purchaseOrderItemId: order.items[3].id, productId: productDId,
              orderedQtySnapshot: 1, shippedQty: 1, unitPriceSnapshot: 10, amount: 10,
              productNameSnapshot: '保留商品 D', productUnitSnapshot: 'kg',
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
    itemDId = delivery.items.find(item => item.productId === productDId)!.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supplier')
      request.user = actor === 'store'
        ? { tenantId, storeId, storeIds: [storeId], userId: storeUserId, role: 'MANAGER' }
        : actor === 'supply-chain'
          ? { tenantId, userId: supplyChainUserId, role: 'SUPPLY_CHAIN', supplierId: null }
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

  it('lets internal supply chain soft-remove one item, recalculates totals, and hides it from reads', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemAId, rowVersion: 0 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, deliveryTotal: '30.00', orderTotal: '30.00' })

    const [delivery, order, removedItem, deliveryList] = await Promise.all([
      prisma.deliveryOrder.findUnique({ where: { id: deliveryId } }),
      prisma.purchaseOrder.findUnique({ where: { id: orderId } }),
      prisma.deliveryOrderItem.findUnique({ where: { id: itemAId } }),
      app.inject({ method: 'GET', url: '/api/deliveries?page=1&pageSize=20', headers: { 'x-test-actor': 'supplier' } }),
    ])
    expect(delivery?.actualTotalAmount.toString()).toBe('30')
    expect(delivery?.rowVersion).toBe(1)
    expect(order?.totalAmount.toString()).toBe('30')
    expect(removedItem?.shippedQty.toString()).toBe('0')
    expect(removedItem?.amount.toString()).toBe('0')
    expect(deliveryList.statusCode).toBe(200)
    expect(deliveryList.json().items[0].items.map((item: any) => item.id)).toEqual([itemBId, itemCId, itemDId])
  })

  it('changes a positive quantity and adds an existing catalog product before delivery', async () => {
    const quantityResponse = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/item-quantity`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemDId, targetQuantity: 2, rowVersion: 1 },
    })
    expect(quantityResponse.statusCode).toBe(200)
    expect(quantityResponse.json()).toMatchObject({ rowVersion: 2, deliveryTotal: '40.00', orderTotal: '40.00' })

    const addResponse = await app.inject({
      method: 'POST',
      url: `/api/deliveries/${deliveryId}/add-item`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { productId: productEId, quantity: 2, rowVersion: 2 },
    })
    expect(addResponse.statusCode).toBe(200)
    expect(addResponse.json()).toMatchObject({ rowVersion: 3, productId: productEId, deliveryTotal: '50.00', orderTotal: '50.00' })
    const added = await prisma.deliveryOrderItem.findUniqueOrThrow({
      where: { deliveryOrderId_productId: { deliveryOrderId: deliveryId, productId: productEId } },
    })
    expect(added.shippedQty.toString()).toBe('2')
    expect(added.unitPriceSnapshot.toString()).toBe('5')
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

    const increase = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/item-quantity`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemBId, targetQuantity: 2, rowVersion: 3 },
    })
    expect(increase.statusCode).toBe(200)
    expect(increase.json()).toMatchObject({ rowVersion: 4, deliveryTotal: '60.00', orderTotal: '60.00' })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productBId } })).stock)).toBe(8)
    expect(Number((await prisma.supplierStockBatch.findUniqueOrThrow({ where: { id: batch.id } })).remainingQty)).toBe(8)
    expect(Number((await prisma.supplierStockReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: poItemB.id } })).fulfilledQty)).toBe(2)

    const decrease = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/item-quantity`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemBId, targetQuantity: 1, rowVersion: 4 },
    })
    expect(decrease.statusCode).toBe(200)
    expect(decrease.json()).toMatchObject({ rowVersion: 5, deliveryTotal: '50.00', orderTotal: '50.00' })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productBId } })).stock)).toBe(9)
    expect(Number((await prisma.supplierStockBatch.findUniqueOrThrow({ where: { id: batch.id } })).remainingQty)).toBe(9)
    expect(Number((await prisma.supplierStockReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: poItemB.id } })).fulfilledQty)).toBe(1)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemBId, rowVersion: 5 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, deliveryTotal: '40.00', orderTotal: '40.00' })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productBId } })).stock)).toBe(10)
    expect(Number((await prisma.supplierStockBatch.findUniqueOrThrow({ where: { id: batch.id } })).remainingQty)).toBe(10)
    expect(await prisma.supplierStockReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: poItemB.id } })).toMatchObject({ status: 'RELEASED' })
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, sourceType: 'DeliveryOrderItemRemoval' } })).toBe(1)
    await prisma.supplier.update({ where: { id: supplierId }, data: { inventoryMode: 'NOT_TRACKED' } })
  })

  it('rejects store-side removal even before receipt', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'store' },
      payload: { itemId: itemCId, rowVersion: 6 },
    })
    expect(response.statusCode).toBe(403)
  })

  it('allows internal supply chain to remove the remaining item before receipt', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemCId, rowVersion: 6 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, deliveryTotal: '30.00', orderTotal: '30.00' })
  })

  it('keeps a zero-quantity item visible until remove is explicitly used', async () => {
    const saveZero = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/item-quantity`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemDId, targetQuantity: 0, rowVersion: 7 },
    })
    expect(saveZero.statusCode).toBe(200)
    expect(saveZero.json()).toMatchObject({ rowVersion: 8, deliveryTotal: '10.00', orderTotal: '10.00' })

    const afterSave = await app.inject({
      method: 'GET',
      url: `/api/deliveries/${deliveryId}`,
      headers: { 'x-test-actor': 'supply-chain' },
    })
    expect(afterSave.statusCode).toBe(200)
    expect(afterSave.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: itemDId, shippedQty: '0' }),
    ]))
    expect((await prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: itemDId } })).removedAt).toBeNull()

    const removeZero = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/remove-item`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { itemId: itemDId, rowVersion: 8 },
    })
    expect(removeZero.statusCode).toBe(200)
    expect(removeZero.json()).toMatchObject({ success: true, alreadyRemoved: false, rowVersion: 9 })

    const afterRemove = await app.inject({
      method: 'GET',
      url: `/api/deliveries/${deliveryId}`,
      headers: { 'x-test-actor': 'supply-chain' },
    })
    expect(afterRemove.statusCode).toBe(200)
    expect(afterRemove.json().items.map((item: any) => item.id)).not.toContain(itemDId)
    expect((await prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: itemDId } })).removedAt).not.toBeNull()
  })

  it('rejects empty, duplicate, and conflicting batch mutations without changing the delivery', async () => {
    const before = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })
    const invalidPayloads = [
      { rowVersion: before.rowVersion },
      {
        rowVersion: before.rowVersion,
        quantityChanges: [
          { itemId: 'duplicate-item', targetQuantity: 1 },
          { itemId: 'duplicate-item', targetQuantity: 2 },
        ],
      },
      {
        rowVersion: before.rowVersion,
        quantityChanges: [{ itemId: 'conflicting-item', targetQuantity: 1 }],
        removals: [{ itemId: 'conflicting-item' }],
      },
    ]

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/deliveries/${deliveryId}/items`,
        headers: { 'x-test-actor': 'supply-chain' },
        payload,
      })
      expect(response.statusCode).toBe(400)
    }

    const after = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })
    expect(after.rowVersion).toBe(before.rowVersion)
    expect(after.actualTotalAmount.toString()).toBe(before.actualTotalAmount.toString())
  })

  it('rejects store-side batch mutation before any item is changed', async () => {
    const before = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${deliveryId}/items`,
      headers: { 'x-test-actor': 'store' },
      payload: {
        rowVersion: before.rowVersion,
        quantityChanges: [{ itemId: itemAId, targetQuantity: 99 }],
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '仅内部供应链可调整配送商品' })
    expect((await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })).rowVersion).toBe(before.rowVersion)
  })

  it('saves quantity, addition, and removal atomically as one batch request', async () => {
    const batchOrder = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-BATCH-${suffix}`, storeId, supplierId, expectedDate: new Date('2026-09-01'),
        totalAmount: 30, originalTotalAmount: 30, currentOrderAmount: 30, status: 'DELIVERING',
        createdById: storeUserId,
        items: {
          create: [
            { productId: productAId, quantity: 2, shippedQty: 2, unitPrice: 10, amount: 20 },
            { productId: productBId, quantity: 1, shippedQty: 1, unitPrice: 10, amount: 10 },
          ],
        },
      },
      include: { items: true },
    })
    const batchDelivery = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-BATCH-${suffix}`, purchaseOrderId: batchOrder.id, storeId, supplierId,
        status: 'SHIPPED', actualTotalAmount: 30, createdById: supplierUserId,
        shippedById: supplierUserId, shippedAt: new Date('2026-09-01T01:00:00.000Z'),
        items: {
          create: batchOrder.items.map(item => ({
            purchaseOrderItemId: item.id,
            productId: item.productId,
            orderedQtySnapshot: item.quantity,
            shippedQty: item.shippedQty,
            unitPriceSnapshot: item.unitPrice,
            amount: item.amount,
            productNameSnapshot: item.productId === productAId ? '批量调整商品' : '批量移除商品',
            productUnitSnapshot: 'kg',
          })),
        },
      },
      include: { items: true },
    })
    const quantityItem = batchDelivery.items.find(item => item.productId === productAId)!
    const removalItem = batchDelivery.items.find(item => item.productId === productBId)!
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${batchDelivery.id}/items`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: {
        rowVersion: 0,
        reason: '商品明细统一保存测试',
        quantityChanges: [{ itemId: quantityItem.id, targetQuantity: 3 }],
        additions: [{
          customProduct: { name: '批量新增商品', unit: '件', unitPrice: 7.5 },
          quantity: 2,
        }],
        removals: [{ itemId: removalItem.id }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      success: true,
      rowVersion: 3,
      changedCount: 1,
      addedCount: 1,
      removedCount: 1,
      deliveryTotal: '45.00',
      orderTotal: '45.00',
    })
    const [removed, added, delivery] = await Promise.all([
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: removalItem.id } }),
      prisma.deliveryOrderItem.findFirstOrThrow({
        where: { deliveryOrderId: batchDelivery.id, productNameSnapshot: '批量新增商品', removedAt: null },
      }),
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: batchDelivery.id } }),
    ])
    expect(removed.removedAt).not.toBeNull()
    expect(removed.shippedQty.toString()).toBe('0')
    expect(added.shippedQty.toString()).toBe('2')
    expect(added.amount.toString()).toBe('15')
    expect(delivery.rowVersion).toBe(3)
    expect((await prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: quantityItem.id } })).shippedQty.toString()).toBe('3')

    const eventsBefore = await prisma.deliveryOrderEvent.count({ where: { tenantId, deliveryOrderId: batchDelivery.id } })
    const rollbackResponse = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${batchDelivery.id}/items`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: {
        rowVersion: 3,
        quantityChanges: [{ itemId: quantityItem.id, targetQuantity: 4 }],
        additions: [{
          customProduct: { name: '应回滚的商品', unit: '件', unitPrice: 3 },
          quantity: 1,
        }],
        removals: [{ itemId: 'missing-item-that-forces-rollback' }],
      },
    })

    expect(rollbackResponse.statusCode).toBe(404)
    expect(rollbackResponse.json()).toEqual({ error: '配送商品不存在' })
    const [afterRollback, retainedAfter, rolledBackProduct, eventsAfter] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: batchDelivery.id } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: quantityItem.id } }),
      prisma.product.findFirst({ where: { tenantId, name: '应回滚的商品' } }),
      prisma.deliveryOrderEvent.count({ where: { tenantId, deliveryOrderId: batchDelivery.id } }),
    ])
    expect(afterRollback.rowVersion).toBe(3)
    expect(afterRollback.actualTotalAmount.toString()).toBe('45')
    expect(retainedAfter.shippedQty.toString()).toBe('3')
    expect(retainedAfter.amount.toString()).toBe('30')
    expect(rolledBackProduct).toBeNull()
    expect(eventsAfter).toBe(eventsBefore)
  })
})
