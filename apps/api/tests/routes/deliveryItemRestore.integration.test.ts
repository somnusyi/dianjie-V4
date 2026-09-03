import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { resolveTenantWarehouseId } from '../../src/services/defaultWarehouse'
import {
  postWarehouseReservationForOrder,
  postWarehouseShipment,
  recordManualWarehouseInbound,
} from '../../src/services/warehouseLedger'

type DeliveryFixture = {
  tenantId: string
  supplierId: string
  storeId: string
  userId: string
  warehouseId: string
  orderId: string
  deliveryId: string
  targetProductId: string
  targetOrderItemId: string
  targetDeliveryItemId: string
}

const tenantIds: string[] = []
const suffix = `delivery-restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let app: ReturnType<typeof Fastify>

function authHeaders(fixture: DeliveryFixture) {
  return {
    'x-test-tenant': fixture.tenantId,
    'x-test-user': fixture.userId,
  }
}

function oneToOneSnapshots() {
  return {
    purchaseUnitSnapshot: '件',
    orderUnitSnapshot: '件',
    costUnitSnapshot: '件',
    inventoryUnitSnapshot: '件',
    inventoryUnitsPerPurchaseUnitSnapshot: 1,
    inventoryUnitsPerOrderUnitSnapshot: 1,
    inventoryUnitsPerCostUnitSnapshot: 1,
    unitConversionStatusSnapshot: 'VERIFIED' as const,
  }
}

async function createFixture(
  tag: string,
  headqWarehouse = false,
  targetQuantity = 2,
  delayedWarehouseReservation = false,
): Promise<DeliveryFixture> {
  const targetAmount = targetQuantity * 10
  const totalAmount = targetAmount + 5
  const tenant = await prisma.tenant.create({
    data: { name: `配送恢复测试 ${tag} ${suffix}`, slug: `${suffix}-${tag}` },
  })
  tenantIds.push(tenant.id)

  const [supplier, store, user] = await Promise.all([
    prisma.supplier.create({
      data: {
        tenantId: tenant.id,
        no: `SUP-${tag}-${suffix}`,
        name: `配送恢复供应商 ${tag}`,
        ...(headqWarehouse ? { sourceType: 'HEADQ_WAREHOUSE' as const } : {}),
      },
    }),
    prisma.store.create({
      data: { tenantId: tenant.id, no: `STORE-${tag}-${suffix}`, name: `配送恢复门店 ${tag}` },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        name: `配送恢复供应链 ${tag}`,
        email: `${tag}-${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLY_CHAIN',
      },
    }),
  ])
  const warehouseId = await resolveTenantWarehouseId(prisma, tenant.id, undefined)

  const [targetProduct, keeperProduct] = await Promise.all([
    prisma.product.create({
      data: {
        tenantId: tenant.id,
        supplierId: supplier.id,
        code: `RESTORE-${tag}-${suffix}`,
        name: `待恢复商品 ${tag}`,
        category: '测试',
        unit: '件',
        purchaseUnit: '件',
        orderUnit: '件',
        costUnit: '件',
        inventoryUnit: '件',
        inventoryUnitsPerPurchaseUnit: 1,
        inventoryUnitsPerOrderUnit: 1,
        inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED',
        price: 10,
        stock: 0,
      },
    }),
    prisma.product.create({
      data: {
        tenantId: tenant.id,
        supplierId: supplier.id,
        code: `KEEP-${tag}-${suffix}`,
        name: `保留商品 ${tag}`,
        category: '测试',
        unit: '件',
        purchaseUnit: '件',
        orderUnit: '件',
        costUnit: '件',
        inventoryUnit: '件',
        inventoryUnitsPerPurchaseUnit: 1,
        inventoryUnitsPerOrderUnit: 1,
        inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED',
        price: 5,
        stock: 0,
      },
    }),
  ])

  if (headqWarehouse) {
    await recordManualWarehouseInbound({
      tenantId: tenant.id,
      userId: user.id,
      productId: targetProduct.id,
      purchaseQuantity: 4,
      totalAmount: 40,
      effectiveAt: new Date('2026-09-01T01:00:00.000Z'),
      idempotencyKey: `restore-inbound-${tag}-${suffix}`,
      sourceName: '配送恢复集成测试',
      batchNo: `RESTORE-${tag}-${suffix}`,
    })
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { inventoryMode: 'STRICT', inventoryActivatedAt: new Date('2026-09-01T01:30:00.000Z') },
    })
  }

  const order = await prisma.purchaseOrder.create({
    data: {
      tenantId: tenant.id,
      no: `PO-${tag}-${suffix}`,
      storeId: store.id,
      supplierId: supplier.id,
      expectedDate: new Date('2026-09-02'),
      totalAmount,
      originalTotalAmount: totalAmount,
      currentOrderAmount: totalAmount,
      status: headqWarehouse ? 'CONFIRMED' : 'DELIVERING',
      createdById: user.id,
      items: {
        create: [
          {
            productId: targetProduct.id,
            quantity: targetQuantity,
            originalQuantity: targetQuantity,
            shippedQty: targetQuantity,
            unitPrice: 10,
            originalUnitPrice: 10,
            amount: targetAmount,
            originalAmount: targetAmount,
            ...oneToOneSnapshots(),
          },
          {
            productId: keeperProduct.id,
            quantity: 1,
            originalQuantity: 1,
            shippedQty: 1,
            unitPrice: 5,
            originalUnitPrice: 5,
            amount: 5,
            originalAmount: 5,
            ...oneToOneSnapshots(),
          },
        ],
      },
    },
    include: { items: true },
  })
  const targetOrderItem = order.items.find(item => item.productId === targetProduct.id)!
  const keeperOrderItem = order.items.find(item => item.productId === keeperProduct.id)!

  if (headqWarehouse && !delayedWarehouseReservation) {
    await postWarehouseReservationForOrder({
      tenantId: tenant.id,
      purchaseOrderId: order.id,
      userId: user.id,
      effectiveAt: new Date('2026-09-01T02:00:00.000Z'),
      lines: [{
        purchaseOrderItemId: targetOrderItem.id,
        productId: targetProduct.id,
        quantity: targetQuantity,
        shippedQty: targetQuantity,
        productName: targetProduct.name,
        productUnit: '件',
        orderUnitSnapshot: '件',
        inventoryUnitSnapshot: '件',
        inventoryUnitsPerOrderUnitSnapshot: 1,
      }],
    })
    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: 'DELIVERING' } })
  }

  const delivery = await prisma.deliveryOrder.create({
    data: {
      tenantId: tenant.id,
      no: `DO-${tag}-${suffix}`,
      purchaseOrderId: order.id,
      storeId: store.id,
      supplierId: supplier.id,
      warehouseId,
      status: 'SHIPPED',
      actualTotalAmount: totalAmount,
      createdById: user.id,
      shippedById: user.id,
      shippedAt: new Date('2026-09-01T03:00:00.000Z'),
      items: {
        create: [
          {
            purchaseOrderItemId: targetOrderItem.id,
            productId: targetProduct.id,
            orderedQtySnapshot: targetQuantity,
            shippedQty: targetQuantity,
            unitPriceSnapshot: 10,
            amount: targetAmount,
            productCodeSnapshot: targetProduct.code,
            productNameSnapshot: targetProduct.name,
            productUnitSnapshot: '件',
            productCategorySnapshot: targetProduct.category,
            ...oneToOneSnapshots(),
          },
          {
            purchaseOrderItemId: keeperOrderItem.id,
            productId: keeperProduct.id,
            orderedQtySnapshot: 1,
            shippedQty: 1,
            unitPriceSnapshot: 5,
            amount: 5,
            productCodeSnapshot: keeperProduct.code,
            productNameSnapshot: keeperProduct.name,
            productUnitSnapshot: '件',
            productCategorySnapshot: keeperProduct.category,
            ...oneToOneSnapshots(),
          },
        ],
      },
    },
    include: { items: true },
  })
  const targetDeliveryItem = delivery.items.find(item => item.productId === targetProduct.id)!

  if (headqWarehouse) {
    await postWarehouseShipment({
      tenantId: tenant.id,
      warehouseId,
      purchaseOrderId: order.id,
      deliveryOrderId: delivery.id,
      orderNo: order.no,
      userId: user.id,
      effectiveAt: new Date('2026-09-01T03:00:00.000Z'),
      lines: [{
        purchaseOrderItemId: targetOrderItem.id,
        productId: targetProduct.id,
        quantity: targetQuantity,
        shippedQty: targetQuantity,
        productName: targetProduct.name,
        productUnit: '件',
        orderUnitSnapshot: '件',
        inventoryUnitSnapshot: '件',
        inventoryUnitsPerOrderUnitSnapshot: 1,
      }],
    })
    if (delayedWarehouseReservation) {
      // Shipment-draft additions now create a consumed reservation when the
      // asynchronous acceptance projector has not run yet. Remove that healed
      // audit row only in this fixture so the projector can recreate the
      // historical late-ACTIVE state that the mutation must still settle.
      await prisma.warehouseLedgerReservation.delete({
        where: { purchaseOrderItemId: targetOrderItem.id },
      })
      await postWarehouseReservationForOrder({
        tenantId: tenant.id,
        purchaseOrderId: order.id,
        userId: user.id,
        effectiveAt: new Date('2026-09-01T03:30:00.000Z'),
        lines: [{
          purchaseOrderItemId: targetOrderItem.id,
          productId: targetProduct.id,
          quantity: targetQuantity,
          shippedQty: targetQuantity,
          productName: targetProduct.name,
          productUnit: '件',
          orderUnitSnapshot: '件',
          inventoryUnitSnapshot: '件',
          inventoryUnitsPerOrderUnitSnapshot: 1,
        }],
      })
      await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: 'DELIVERING' } })
    }
  }

  return {
    tenantId: tenant.id,
    supplierId: supplier.id,
    storeId: store.id,
    userId: user.id,
    warehouseId,
    orderId: order.id,
    deliveryId: delivery.id,
    targetProductId: targetProduct.id,
    targetOrderItemId: targetOrderItem.id,
    targetDeliveryItemId: targetDeliveryItem.id,
  }
}

async function removeTarget(fixture: DeliveryFixture, rowVersion = 0) {
  return app.inject({
    method: 'PATCH',
    url: `/api/deliveries/${fixture.deliveryId}/remove-item`,
    headers: authHeaders(fixture),
    payload: { itemId: fixture.targetDeliveryItemId, rowVersion },
  })
}

async function deleteFixture(tenantId: string) {
  await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
  await prisma.opLog.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerReservation.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
  await prisma.warehouseStock.deleteMany({ where: { tenantId } })
  await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
  await prisma.receipt.deleteMany({ where: { tenantId } })
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
  await prisma.warehouse.deleteMany({ where: { tenantId } })
  await prisma.tenant.delete({ where: { id: tenantId } })
}

describe('delivery item restoration (integration)', () => {
  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: String(request.headers['x-test-tenant']),
        userId: String(request.headers['x-test-user']),
        role: 'SUPPLY_CHAIN',
        supplierId: null,
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    while (tenantIds.length > 0) await deleteFixture(tenantIds.pop()!)
  })

  afterEach(async () => {
    while (tenantIds.length > 0) await deleteFixture(tenantIds.pop()!)
  })

  it('restores the only removed delivery item on the same rows after its product is disabled', async () => {
    const fixture = await createFixture('single')
    await prisma.deliveryOrderItem.deleteMany({
      where: { deliveryOrderId: fixture.deliveryId, productId: { not: fixture.targetProductId } },
    })
    await prisma.purchaseOrderItem.deleteMany({
      where: { purchaseOrderId: fixture.orderId, productId: { not: fixture.targetProductId } },
    })
    await Promise.all([
      prisma.deliveryOrder.update({ where: { id: fixture.deliveryId }, data: { actualTotalAmount: 20 } }),
      prisma.purchaseOrder.update({ where: { id: fixture.orderId }, data: { totalAmount: 20 } }),
    ])

    const removal = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 0,
        removals: [{ itemId: fixture.targetDeliveryItemId }],
      },
    })
    expect(removal.statusCode).toBe(200)
    expect(removal.json()).toMatchObject({
      rowVersion: 1,
      removedCount: 1,
      deliveryTotal: '0.00',
      orderTotal: '0.00',
    })
    await prisma.product.update({
      where: { id: fixture.targetProductId },
      data: { status: 'DISABLED' },
    })

    const restore = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 1,
        additions: [{ productId: fixture.targetProductId, quantity: 2 }],
      },
    })
    expect(restore.statusCode).toBe(200)
    expect(restore.json()).toMatchObject({
      rowVersion: 2,
      addedCount: 1,
      deliveryTotal: '20.00',
      orderTotal: '20.00',
    })
    expect(await prisma.deliveryOrderItem.count({
      where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
    })).toBe(1)
    expect(await prisma.purchaseOrderItem.count({
      where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
    })).toBe(1)
    const restored = await prisma.deliveryOrderItem.findUniqueOrThrow({
      where: { id: fixture.targetDeliveryItemId },
    })
    expect(restored.purchaseOrderItemId).toBe(fixture.targetOrderItemId)
    expect(restored.removedAt).toBeNull()
    expect(restored.shippedQty.toString()).toBe('2')
    expect((await prisma.product.findUniqueOrThrow({
      where: { id: fixture.targetProductId },
    })).status).toBe('DISABLED')
  })

  it('rejects a disabled product that has no historical delivery row', async () => {
    const fixture = await createFixture('disabled-new')
    const disabledProduct = await prisma.product.create({
      data: {
        tenantId: fixture.tenantId,
        supplierId: fixture.supplierId,
        code: `DISABLED-NEW-${suffix}`,
        name: '未配送停用商品',
        unit: '件',
        price: 8,
        status: 'DISABLED',
      },
    })

    const addition = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 0,
        additions: [{ productId: disabledProduct.id, quantity: 1 }],
      },
    })
    expect(addition.statusCode).toBe(404)
    expect(addition.json()).toEqual({ error: '商品不存在、已停用或不属于当前供应商' })
    expect(await prisma.deliveryOrderItem.count({
      where: { deliveryOrderId: fixture.deliveryId, productId: disabledProduct.id },
    })).toBe(0)
    expect(await prisma.purchaseOrderItem.count({
      where: { purchaseOrderId: fixture.orderId, productId: disabledProduct.id },
    })).toBe(0)
    expect((await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: fixture.deliveryId },
    })).rowVersion).toBe(0)
  })

  it('restores the original rows, supports zero then increase, and restores again after another removal', async () => {
    const fixture = await createFixture('repeat')

    const firstRemoval = await removeTarget(fixture)
    expect(firstRemoval.statusCode).toBe(200)
    expect(firstRemoval.json()).toMatchObject({ rowVersion: 1, deliveryTotal: '5.00', orderTotal: '5.00' })

    // Restoring an audit row must preserve its frozen price instead of repricing from mutable catalog data.
    await prisma.product.update({ where: { id: fixture.targetProductId }, data: { price: 99 } })
    const firstRestore = await app.inject({
      method: 'POST',
      url: `/api/deliveries/${fixture.deliveryId}/add-item`,
      headers: authHeaders(fixture),
      payload: { productId: fixture.targetProductId, quantity: 3, rowVersion: 1 },
    })
    expect(firstRestore.statusCode).toBe(200)
    expect(firstRestore.json()).toMatchObject({
      itemId: fixture.targetDeliveryItemId,
      productId: fixture.targetProductId,
      rowVersion: 2,
      deliveryTotal: '35.00',
      orderTotal: '35.00',
    })

    let [deliveryRows, orderRows] = await Promise.all([
      prisma.deliveryOrderItem.findMany({
        where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
      }),
      prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
      }),
    ])
    expect(deliveryRows).toHaveLength(1)
    expect(orderRows).toHaveLength(1)
    expect(deliveryRows[0].id).toBe(fixture.targetDeliveryItemId)
    expect(deliveryRows[0].purchaseOrderItemId).toBe(fixture.targetOrderItemId)
    expect(deliveryRows[0].removedAt).toBeNull()
    expect(deliveryRows[0].shippedQty.toString()).toBe('3')
    expect(deliveryRows[0].unitPriceSnapshot.toString()).toBe('10')
    expect(deliveryRows[0].amount.toString()).toBe('30')
    expect(orderRows[0].id).toBe(fixture.targetOrderItemId)
    expect(orderRows[0].shippedQty?.toString()).toBe('3')
    expect(orderRows[0].amount.toString()).toBe('30')

    const saveZero = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/item-quantity`,
      headers: authHeaders(fixture),
      payload: { itemId: fixture.targetDeliveryItemId, targetQuantity: 0, rowVersion: 2 },
    })
    expect(saveZero.statusCode).toBe(200)
    expect(saveZero.json()).toMatchObject({ rowVersion: 3, deliveryTotal: '5.00', orderTotal: '5.00' })
    expect((await prisma.deliveryOrderItem.findUniqueOrThrow({
      where: { id: fixture.targetDeliveryItemId },
    })).removedAt).toBeNull()

    const increaseAgain = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/item-quantity`,
      headers: authHeaders(fixture),
      payload: { itemId: fixture.targetDeliveryItemId, targetQuantity: 1.5, rowVersion: 3 },
    })
    expect(increaseAgain.statusCode).toBe(200)
    expect(increaseAgain.json()).toMatchObject({ rowVersion: 4, deliveryTotal: '20.00', orderTotal: '20.00' })

    const secondRemoval = await removeTarget(fixture, 4)
    expect(secondRemoval.statusCode).toBe(200)
    expect(secondRemoval.json()).toMatchObject({ rowVersion: 5, deliveryTotal: '5.00', orderTotal: '5.00' })

    const secondRestore = await app.inject({
      method: 'POST',
      url: `/api/deliveries/${fixture.deliveryId}/add-item`,
      headers: authHeaders(fixture),
      payload: { productId: fixture.targetProductId, quantity: 1, rowVersion: 5 },
    })
    expect(secondRestore.statusCode).toBe(200)
    expect(secondRestore.json()).toMatchObject({
      itemId: fixture.targetDeliveryItemId,
      rowVersion: 6,
      deliveryTotal: '15.00',
      orderTotal: '15.00',
    })

    ;[deliveryRows, orderRows] = await Promise.all([
      prisma.deliveryOrderItem.findMany({
        where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
      }),
      prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
      }),
    ])
    expect(deliveryRows).toHaveLength(1)
    expect(orderRows).toHaveLength(1)
    expect(deliveryRows[0]).toMatchObject({
      id: fixture.targetDeliveryItemId,
      purchaseOrderItemId: fixture.targetOrderItemId,
      removedAt: null,
    })
    expect(deliveryRows[0].shippedQty.toString()).toBe('1')
    expect(deliveryRows[0].amount.toString()).toBe('10')
  })

  it('keeps DELIVERED deliveries editable until a receipt exists', async () => {
    const fixture = await createFixture('delivered-open')
    await prisma.deliveryOrder.update({
      where: { id: fixture.deliveryId },
      data: { status: 'DELIVERED', deliveredAt: new Date('2026-09-02T04:00:00.000Z') },
    })

    const removal = await removeTarget(fixture)
    expect(removal.statusCode).toBe(200)
    expect(removal.json()).toMatchObject({ rowVersion: 1, deliveryTotal: '5.00', orderTotal: '5.00' })

    const restore = await app.inject({
      method: 'POST',
      url: `/api/deliveries/${fixture.deliveryId}/add-item`,
      headers: authHeaders(fixture),
      payload: { productId: fixture.targetProductId, quantity: 2, rowVersion: 1 },
    })
    expect(restore.statusCode).toBe(200)
    expect(restore.json()).toMatchObject({
      itemId: fixture.targetDeliveryItemId,
      rowVersion: 2,
      deliveryTotal: '25.00',
      orderTotal: '25.00',
    })

    const quantityChange = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/item-quantity`,
      headers: authHeaders(fixture),
      payload: { itemId: fixture.targetDeliveryItemId, targetQuantity: 3, rowVersion: 2 },
    })
    expect(quantityChange.statusCode).toBe(200)
    expect(quantityChange.json()).toMatchObject({ rowVersion: 3, deliveryTotal: '35.00', orderTotal: '35.00' })

    const [delivery, restoredItem] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
    ])
    expect(delivery.status).toBe('DELIVERED')
    expect(delivery.rowVersion).toBe(3)
    expect(restoredItem.removedAt).toBeNull()
    expect(restoredItem.shippedQty.toString()).toBe('3')
    expect(await prisma.deliveryOrderItem.count({
      where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
    })).toBe(1)
  })

  it('locks remove, restore/add, and quantity mutations as soon as a receipt exists', async () => {
    const fixture = await createFixture('receipt-lock')
    await prisma.deliveryOrder.update({
      where: { id: fixture.deliveryId },
      data: { status: 'DELIVERED', deliveredAt: new Date('2026-09-02T04:00:00.000Z') },
    })
    await prisma.receipt.create({
      data: {
        tenantId: fixture.tenantId,
        no: `RK-receipt-lock-${suffix}`,
        storeId: fixture.storeId,
        supplierId: fixture.supplierId,
        deliveryDate: new Date('2026-09-02'),
        totalAmount: 25,
        status: 'DRAFT',
        createdById: fixture.userId,
        purchaseOrderId: fixture.orderId,
        deliveryOrderId: fixture.deliveryId,
      },
    })
    const [deliveryBefore, itemBefore, eventsBefore] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
      prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: fixture.deliveryId } }),
    ])

    const [quantityChange, addOrRestore, removal] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/deliveries/${fixture.deliveryId}/item-quantity`,
        headers: authHeaders(fixture),
        payload: { itemId: fixture.targetDeliveryItemId, targetQuantity: 3, rowVersion: 0 },
      }),
      app.inject({
        method: 'POST',
        url: `/api/deliveries/${fixture.deliveryId}/add-item`,
        headers: authHeaders(fixture),
        payload: { productId: fixture.targetProductId, quantity: 2, rowVersion: 0 },
      }),
      removeTarget(fixture),
    ])
    expect(quantityChange.statusCode).toBe(409)
    expect(quantityChange.json()).toEqual({ error: '配送单已生成收货单，不能调整商品' })
    expect(addOrRestore.statusCode).toBe(409)
    expect(addOrRestore.json()).toEqual({ error: '配送单已生成收货单，不能调整商品' })
    expect(removal.statusCode).toBe(409)
    expect(removal.json()).toEqual({ error: '配送单已生成收货单，不能移除商品' })

    const [deliveryAfter, itemAfter, eventsAfter] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
      prisma.deliveryOrderEvent.count({ where: { deliveryOrderId: fixture.deliveryId } }),
    ])
    expect(deliveryAfter.rowVersion).toBe(deliveryBefore.rowVersion)
    expect(deliveryAfter.actualTotalAmount.toString()).toBe(deliveryBefore.actualTotalAmount.toString())
    expect(itemAfter.removedAt).toBeNull()
    expect(itemAfter.shippedQty.toString()).toBe(itemBefore.shippedQty.toString())
    expect(itemAfter.amount.toString()).toBe(itemBefore.amount.toString())
    expect(eventsAfter).toBe(eventsBefore)
  })

  it('caps HEADQ reservation fulfillment when shipped quantity increases beyond the original reservation', async () => {
    const fixture = await createFixture('headq-cap', true, 1)
    const [balanceBefore, reservationBefore] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
    ])
    expect(Number(balanceBefore.physicalQty)).toBe(3)
    expect(Number(balanceBefore.reservedQty)).toBe(0)
    expect(Number(reservationBefore.inventoryQuantity)).toBe(1)
    expect(Number(reservationBefore.fulfilledInventoryQty)).toBe(1)
    expect(reservationBefore.status).toBe('CONSUMED')

    const increase = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/item-quantity`,
      headers: authHeaders(fixture),
      payload: { itemId: fixture.targetDeliveryItemId, targetQuantity: 2, rowVersion: 0 },
    })
    expect(increase.statusCode).toBe(200)
    expect(increase.json()).toMatchObject({
      rowVersion: 1,
      deliveryTotal: '25.00',
      orderTotal: '25.00',
    })

    const [balanceAfter, reservationAfter, deliveryRows, orderRows, outboundMovements] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.deliveryOrderItem.findMany({
        where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
      }),
      prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
      }),
      prisma.warehouseLedgerMovement.findMany({
        where: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
          type: 'ORDER_OUTBOUND',
        },
      }),
    ])
    expect(Number(balanceAfter.physicalQty)).toBe(2)
    expect(Number(balanceAfter.reservedQty)).toBe(0)
    expect(Number(reservationAfter.inventoryQuantity)).toBe(1)
    expect(Number(reservationAfter.fulfilledInventoryQty)).toBe(1)
    expect(reservationAfter.status).toBe('CONSUMED')
    expect(reservationAfter.releasedAt).toBeNull()
    expect(outboundMovements).toHaveLength(2)
    expect(outboundMovements.reduce((sum, item) => sum + Number(item.physicalDelta), 0)).toBe(-2)
    expect(deliveryRows).toHaveLength(1)
    expect(orderRows).toHaveLength(1)
    expect(deliveryRows[0].id).toBe(fixture.targetDeliveryItemId)
    expect(deliveryRows[0].shippedQty.toString()).toBe('2')
    expect(orderRows[0].id).toBe(fixture.targetOrderItemId)
    expect(orderRows[0].shippedQty?.toString()).toBe('2')
  })

  it('settles a late ACTIVE HEADQ reservation before removal without deducting physical stock twice', async () => {
    const fixture = await createFixture('headq-active', true, 1, true)
    const [balanceBefore, reservationBefore, outboundBefore] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.warehouseLedgerMovement.count({
        where: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
          type: 'ORDER_OUTBOUND',
        },
      }),
    ])
    expect(Number(balanceBefore.physicalQty)).toBe(3)
    expect(Number(balanceBefore.reservedQty)).toBe(1)
    expect(reservationBefore.status).toBe('ACTIVE')
    expect(Number(reservationBefore.fulfilledInventoryQty)).toBe(0)
    expect(outboundBefore).toBe(1)

    const removal = await removeTarget(fixture)
    expect(removal.statusCode).toBe(200)
    expect(removal.json()).toMatchObject({ rowVersion: 1, deliveryTotal: '5.00', orderTotal: '5.00' })

    const [balanceAfter, reservationAfter, lotAfter, outboundAfter, reversals, lateRelease, itemAfter] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
      prisma.warehouseLedgerMovement.findMany({
        where: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
          type: 'ORDER_OUTBOUND',
        },
      }),
      prisma.warehouseLedgerMovement.findMany({
        where: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
          type: 'REVERSAL',
        },
      }),
      prisma.warehouseLedgerMovement.findFirst({
        where: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
          type: 'ORDER_RELEASED',
          idempotencyKey: `late-reservation-release:${fixture.deliveryId}:${fixture.targetOrderItemId}`,
        },
      }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
    ])
    expect(Number(balanceAfter.physicalQty)).toBe(4)
    expect(Number(balanceAfter.reservedQty)).toBe(0)
    expect(reservationAfter.status).toBe('RELEASED')
    expect(Number(reservationAfter.fulfilledInventoryQty)).toBe(0)
    expect(Number(lotAfter.remainingQty)).toBe(4)
    expect(outboundAfter).toHaveLength(1)
    expect(reversals).toHaveLength(1)
    expect([...outboundAfter, ...reversals].reduce((sum, item) => sum + Number(item.physicalDelta), 0)).toBe(0)
    expect(lateRelease).not.toBeNull()
    expect(Number(lateRelease?.physicalDelta)).toBe(0)
    expect(Number(lateRelease?.reservedDelta)).toBe(-1)
    expect(itemAfter.removedAt).not.toBeNull()
    expect(itemAfter.shippedQty.toString()).toBe('0')
  })

  it('keeps HEADQ warehouse physical stock and consumed reservation at the restored net quantity', async () => {
    const fixture = await createFixture('headq-net', true)
    const initialBalance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: {
        tenantId_warehouseId_productId: {
          tenantId: fixture.tenantId,
          warehouseId: fixture.warehouseId,
          productId: fixture.targetProductId,
        },
      },
    })
    expect(Number(initialBalance.physicalQty)).toBe(2)
    expect(Number(initialBalance.reservedQty)).toBe(0)

    const removal = await removeTarget(fixture)
    expect(removal.statusCode).toBe(200)
    expect(removal.json()).toMatchObject({ rowVersion: 1, deliveryTotal: '5.00', orderTotal: '5.00' })

    let [balance, reservation, lot] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
    ])
    expect(Number(balance.physicalQty)).toBe(4)
    expect(Number(balance.reservedQty)).toBe(0)
    expect(reservation.status).toBe('RELEASED')
    expect(Number(reservation.fulfilledInventoryQty)).toBe(0)
    expect(reservation.releasedAt).not.toBeNull()
    expect(reservation.consumedAt).toBeNull()
    expect(Number(lot.remainingQty)).toBe(4)

    const restore = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 1,
        additions: [{ productId: fixture.targetProductId, quantity: 2 }],
      },
    })
    expect(restore.statusCode).toBe(200)
    expect(restore.json()).toMatchObject({
      rowVersion: 2,
      addedCount: 1,
      deliveryTotal: '25.00',
      orderTotal: '25.00',
    })

    ;[balance, reservation, lot] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
    ])
    expect(Number(balance.physicalQty)).toBe(2)
    expect(Number(balance.reservedQty)).toBe(0)
    expect(reservation.status).toBe('CONSUMED')
    expect(Number(reservation.fulfilledInventoryQty)).toBe(2)
    expect(reservation.releasedAt).toBeNull()
    expect(reservation.consumedAt).not.toBeNull()
    expect(Number(lot.remainingQty)).toBe(2)

    const secondRemoval = await removeTarget(fixture, 2)
    expect(secondRemoval.statusCode).toBe(200)
    expect(secondRemoval.json()).toMatchObject({ rowVersion: 3, deliveryTotal: '5.00', orderTotal: '5.00' })
    const secondRestore = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 3,
        additions: [{ productId: fixture.targetProductId, quantity: 1 }],
      },
    })
    expect(secondRestore.statusCode).toBe(200)
    expect(secondRestore.json()).toMatchObject({
      rowVersion: 4,
      addedCount: 1,
      deliveryTotal: '15.00',
      orderTotal: '15.00',
    })

    ;[balance, reservation, lot] = await Promise.all([
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({
        where: { purchaseOrderItemId: fixture.targetOrderItemId },
      }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
    ])
    expect(Number(balance.physicalQty)).toBe(3)
    expect(Number(balance.reservedQty)).toBe(0)
    expect(reservation.status).toBe('CONSUMED')
    expect(Number(reservation.fulfilledInventoryQty)).toBe(1)
    expect(reservation.releasedAt).not.toBeNull()
    expect(reservation.consumedAt).not.toBeNull()
    expect(Number(lot.remainingQty)).toBe(3)

    const fulfillmentMovements = await prisma.warehouseLedgerMovement.findMany({
      where: {
        tenantId: fixture.tenantId,
        warehouseId: fixture.warehouseId,
        productId: fixture.targetProductId,
        type: { in: ['ORDER_OUTBOUND', 'REVERSAL'] },
      },
    })
    expect(fulfillmentMovements.filter(item => item.type === 'ORDER_OUTBOUND')).toHaveLength(3)
    expect(fulfillmentMovements.filter(item => item.type === 'REVERSAL')).toHaveLength(2)
    expect(fulfillmentMovements.reduce((sum, item) => sum + Number(item.physicalDelta), 0)).toBe(-1)

    const [deliveryRows, orderRows] = await Promise.all([
      prisma.deliveryOrderItem.findMany({
        where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
      }),
      prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
      }),
    ])
    expect(deliveryRows).toHaveLength(1)
    expect(orderRows).toHaveLength(1)
    expect(deliveryRows[0].id).toBe(fixture.targetDeliveryItemId)
    expect(deliveryRows[0].purchaseOrderItemId).toBe(fixture.targetOrderItemId)
    expect(deliveryRows[0].removedAt).toBeNull()
    expect(deliveryRows[0].shippedQty.toString()).toBe('1')
    expect(deliveryRows[0].amount.toString()).toBe('10')
  })

  it('rolls back a HEADQ restore, ledger consumption, and reservation update when a later batch mutation fails', async () => {
    const fixture = await createFixture('headq-rollback', true)
    const removal = await removeTarget(fixture)
    expect(removal.statusCode).toBe(200)

    const [deliveryBefore, itemBefore, orderItemBefore, balanceBefore, reservationBefore, lotBefore, movementsBefore, eventsBefore] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
      prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: fixture.targetOrderItemId } }),
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: fixture.targetOrderItemId } }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
      prisma.warehouseLedgerMovement.count({ where: { tenantId: fixture.tenantId } }),
      prisma.deliveryOrderEvent.count({ where: { tenantId: fixture.tenantId, deliveryOrderId: fixture.deliveryId } }),
    ])

    const failedBatch = await app.inject({
      method: 'PATCH',
      url: `/api/deliveries/${fixture.deliveryId}/items`,
      headers: authHeaders(fixture),
      payload: {
        rowVersion: 1,
        additions: [{ productId: fixture.targetProductId, quantity: 2 }],
        removals: [{ itemId: 'missing-item-after-restore' }],
      },
    })
    expect(failedBatch.statusCode).toBe(404)
    expect(failedBatch.json()).toEqual({ error: '配送商品不存在' })

    const [deliveryAfter, itemAfter, orderItemAfter, balanceAfter, reservationAfter, lotAfter, movementsAfter, eventsAfter] = await Promise.all([
      prisma.deliveryOrder.findUniqueOrThrow({ where: { id: fixture.deliveryId } }),
      prisma.deliveryOrderItem.findUniqueOrThrow({ where: { id: fixture.targetDeliveryItemId } }),
      prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: fixture.targetOrderItemId } }),
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: {
          tenantId_warehouseId_productId: {
            tenantId: fixture.tenantId,
            warehouseId: fixture.warehouseId,
            productId: fixture.targetProductId,
          },
        },
      }),
      prisma.warehouseLedgerReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: fixture.targetOrderItemId } }),
      prisma.warehouseLedgerLot.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, warehouseId: fixture.warehouseId, productId: fixture.targetProductId },
      }),
      prisma.warehouseLedgerMovement.count({ where: { tenantId: fixture.tenantId } }),
      prisma.deliveryOrderEvent.count({ where: { tenantId: fixture.tenantId, deliveryOrderId: fixture.deliveryId } }),
    ])

    expect(deliveryAfter.rowVersion).toBe(deliveryBefore.rowVersion)
    expect(deliveryAfter.actualTotalAmount.toString()).toBe(deliveryBefore.actualTotalAmount.toString())
    expect(itemAfter.removedAt?.toISOString()).toBe(itemBefore.removedAt?.toISOString())
    expect(itemAfter.shippedQty.toString()).toBe(itemBefore.shippedQty.toString())
    expect(itemAfter.amount.toString()).toBe(itemBefore.amount.toString())
    expect(orderItemAfter.shippedQty?.toString()).toBe(orderItemBefore.shippedQty?.toString())
    expect(orderItemAfter.amount.toString()).toBe(orderItemBefore.amount.toString())
    expect(balanceAfter.physicalQty.toString()).toBe(balanceBefore.physicalQty.toString())
    expect(balanceAfter.reservedQty.toString()).toBe(balanceBefore.reservedQty.toString())
    expect(reservationAfter.status).toBe(reservationBefore.status)
    expect(reservationAfter.fulfilledInventoryQty.toString()).toBe(reservationBefore.fulfilledInventoryQty.toString())
    expect(lotAfter.remainingQty.toString()).toBe(lotBefore.remainingQty.toString())
    expect(movementsAfter).toBe(movementsBefore)
    expect(eventsAfter).toBe(eventsBefore)
    expect(await prisma.deliveryOrderItem.count({
      where: { deliveryOrderId: fixture.deliveryId, productId: fixture.targetProductId },
    })).toBe(1)
    expect(await prisma.purchaseOrderItem.count({
      where: { purchaseOrderId: fixture.orderId, productId: fixture.targetProductId },
    })).toBe(1)
  })
})
