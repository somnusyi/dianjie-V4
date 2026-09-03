import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'

const suffix = `shipment-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let supplierUserId = ''
let chefUserId = ''
let firstProductId = ''
let secondProductId = ''
let addedProductId = ''
let app: ReturnType<typeof Fastify>

describe('server-backed CONFIRMED shipment draft (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `发货草稿测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `SUP-${suffix}`, name: '发货草稿供应商', inventoryMode: 'STRICT' },
    })
    supplierId = supplier.id
    const store = await prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '发货草稿门店' } })
    storeId = store.id
    const [supplierUser, chefUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, supplierId, name: '草稿供应商', email: `supplier-${suffix}@local.test`,
          password: 'integration-test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '草稿厨师长', email: `chef-${suffix}@local.test`,
          password: 'integration-test-only', role: 'KITCHEN_LEAD',
        },
      }),
    ])
    supplierUserId = supplierUser.id
    chefUserId = chefUser.id

    const products = await Promise.all(['A', 'B', 'ADD'].map(label => prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-${label}`, name: `草稿商品${label}`, category: '测试', unit: '斤',
        purchaseUnit: '箱', inventoryUnit: 'g', orderUnit: '斤', costUnit: 'g',
        inventoryUnitsPerPurchaseUnit: 10000, inventoryUnitsPerOrderUnit: 500,
        inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED',
        price: 0.02, stock: 20, minOrderQty: 1, stepQty: 1,
      },
    })))
    ;[firstProductId, secondProductId, addedProductId] = products.map(product => product.id)
    await prisma.supplierStockBatch.createMany({
      data: products.map((product, index) => ({
        tenantId, supplierId, productId: product.id, batchNo: `DRAFT-${index}-${suffix}`,
        kind: 'OPENING' as const, initialQty: 20, remainingQty: 20, createdById: supplierUserId,
      })),
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'chef')
      request.user = actor === 'supplier'
        ? { tenantId, supplierId, userId: supplierUserId, role: 'SUPPLIER_OWNER' }
        : { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
    })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
    await prisma.receipt.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderRevision.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.notification.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  async function createAndConfirm(productIds: string[]) {
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: { 'x-test-actor': 'chef' },
      payload: {
        supplierId, storeId, expectedDate: '2026-09-10', idempotencyKey: `create-${suffix}-${Math.random()}`,
        items: productIds.map(productId => ({ productId, quantity: 2, unitPrice: 999 })),
      },
    })
    expect(created.statusCode).toBe(200)
    const order = created.json()
    const confirmed = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/confirm`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(confirmed.statusCode).toBe(200)
    return (await app.inject({
      method: 'GET', url: `/api/orders/${order.id}`, headers: { 'x-test-actor': 'supplier' },
    })).json()
  }

  it('persists zero, remove/restore and additions without touching fulfillment facts, then promotes the same delivery once', async () => {
    const order = await createAndConfirm([firstProductId, secondProductId])
    const first = order.items.find((item: any) => item.productId === firstProductId)
    const second = order.items.find((item: any) => item.productId === secondProductId)
    const before = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })
    const beforeStocks = await prisma.product.findMany({
      where: { id: { in: [firstProductId, secondProductId, addedProductId] } }, orderBy: { id: 'asc' },
      select: { id: true, stock: true },
    })
    const beforeDoSequence = await prisma.businessSequence.findFirst({ where: { tenantId, scope: 'DO' } })

    const saved = await app.inject({
      method: 'PUT', url: `/api/orders/${order.id}/shipment-draft`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        orderRowVersion: order.rowVersion,
        items: [
          { purchaseOrderItemId: first.id, productId: firstProductId, shippedQty: 0 },
          { purchaseOrderItemId: second.id, productId: secondProductId, shippedQty: 1, removed: true },
          { productId: addedProductId, shippedQty: 3 },
        ],
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ success: true, rowVersion: 1 })
    expect(saved.json().deliveryNo).toBe(`DR-${order.id}`)

    const afterSave = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id }, include: { items: true },
    })
    expect(afterSave).toMatchObject({ status: 'CONFIRMED', rowVersion: before.rowVersion })
    expect(afterSave.totalAmount.toFixed(2)).toBe(before.totalAmount.toFixed(2))
    expect(afterSave.originalTotalAmount?.toFixed(2)).toBe(before.originalTotalAmount?.toFixed(2))
    expect(afterSave.currentOrderAmount?.toFixed(2)).toBe(before.currentOrderAmount?.toFixed(2))
    expect(afterSave.items).toHaveLength(2)
    expect(afterSave.items.every(item => item.shippedQty === null)).toBe(true)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId } })).toBe(0)
    expect(await prisma.product.findMany({
      where: { id: { in: [firstProductId, secondProductId, addedProductId] } }, orderBy: { id: 'asc' },
      select: { id: true, stock: true },
    })).toEqual(beforeStocks)
    expect(await prisma.supplierStockReservation.count({
      where: { purchaseOrderId: order.id, status: 'ACTIVE' },
    })).toBe(2)
    expect(await prisma.businessSequence.findFirst({ where: { tenantId, scope: 'DO' } })).toEqual(beforeDoSequence)

    const refreshed = await app.inject({
      method: 'GET', url: `/api/orders/${order.id}`, headers: { 'x-test-actor': 'supplier' },
    })
    expect(refreshed.statusCode).toBe(200)
    const draftFromRefresh = refreshed.json().deliveries.find((delivery: any) => delivery.status === 'DRAFT')
    expect(draftFromRefresh.id).toBe(saved.json().deliveryId)
    expect(draftFromRefresh.items.map((item: any) => item.productId).sort()).toEqual(
      [firstProductId, addedProductId].sort(),
    )
    expect(Number(draftFromRefresh.items.find((item: any) => item.productId === firstProductId).shippedQty)).toBe(0)

    const restored = await app.inject({
      method: 'PUT', url: `/api/orders/${order.id}/shipment-draft`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        orderRowVersion: order.rowVersion,
        draftRowVersion: saved.json().rowVersion,
        items: [
          { purchaseOrderItemId: first.id, productId: firstProductId, shippedQty: 0 },
          { purchaseOrderItemId: second.id, productId: secondProductId, shippedQty: 1 },
          { productId: addedProductId, shippedQty: 4 },
        ],
      },
    })
    expect(restored.statusCode).toBe(200)
    const restoredRaw = await prisma.deliveryOrderItem.findFirstOrThrow({
      where: { deliveryOrderId: saved.json().deliveryId, productId: secondProductId },
    })
    expect(restoredRaw.removedAt).toBeNull()
    expect(Number(restoredRaw.shippedQty)).toBe(1)

    const removedAgain = await app.inject({
      method: 'PUT', url: `/api/orders/${order.id}/shipment-draft`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        orderRowVersion: order.rowVersion,
        draftRowVersion: restored.json().rowVersion,
        items: [
          { purchaseOrderItemId: first.id, productId: firstProductId, shippedQty: 0 },
          { purchaseOrderItemId: second.id, productId: secondProductId, shippedQty: 1, removed: true },
          { productId: addedProductId, shippedQty: 4 },
        ],
      },
    })
    expect(removedAgain.statusCode).toBe(200)

    // A later save may omit a tombstone because GET order details hides it.
    const savedAfterRefresh = await app.inject({
      method: 'PUT', url: `/api/orders/${order.id}/shipment-draft`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        orderRowVersion: order.rowVersion,
        draftRowVersion: removedAgain.json().rowVersion,
        items: [
          { purchaseOrderItemId: first.id, productId: firstProductId, shippedQty: 0 },
          { productId: addedProductId, shippedQty: 5 },
        ],
      },
    })
    expect(savedAfterRefresh.statusCode).toBe(200)
    const stillRemoved = await prisma.deliveryOrderItem.findFirstOrThrow({
      where: { deliveryOrderId: saved.json().deliveryId, productId: secondProductId },
    })
    expect(stillRemoved.removedAt).toBeInstanceOf(Date)

    const stale = await app.inject({
      method: 'PUT', url: `/api/orders/${order.id}/shipment-draft`, headers: { 'x-test-actor': 'supplier' },
      payload: {
        orderRowVersion: order.rowVersion,
        draftRowVersion: removedAgain.json().rowVersion,
        items: [{ purchaseOrderItemId: first.id, productId: firstProductId, shippedQty: 0 }],
      },
    })
    expect(stale.statusCode).toBe(409)

    const missingDraftVersion = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/ship`,
      headers: { 'x-test-actor': 'supplier' },
      payload: { idempotencyKey: `ship-draft-missing-version-${suffix}` },
    })
    expect(missingDraftVersion.statusCode).toBe(409)
    expect(missingDraftVersion.json().error).toBe('请刷新订单后再确认发货')

    const staleDraftVersion = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${order.id}/ship`,
      headers: { 'x-test-actor': 'supplier' },
      payload: {
        idempotencyKey: `ship-draft-stale-version-${suffix}`,
        draftRowVersion: removedAgain.json().rowVersion,
      },
    })
    expect(staleDraftVersion.statusCode).toBe(409)
    expect(staleDraftVersion.json().error).toBe('发货草稿已更新，请刷新后确认最新商品明细')

    const shipPayload = {
      idempotencyKey: `ship-draft-${suffix}`,
      note: '以已保存草稿发货',
      draftRowVersion: savedAfterRefresh.json().rowVersion,
    }
    const shipped = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload: shipPayload,
    })
    expect(shipped.statusCode).toBe(200)
    expect(shipped.json().deliveryId).toBe(saved.json().deliveryId)
    expect(shipped.json().deliveryNo).toMatch(/^DO\d+$/)
    const finalDelivery = await prisma.deliveryOrder.findUniqueOrThrow({
      where: { id: saved.json().deliveryId }, include: { items: true },
    })
    expect(finalDelivery.status).toBe('SHIPPED')
    expect(finalDelivery.items).toHaveLength(3)
    expect(finalDelivery.items.find(item => item.productId === firstProductId)).toMatchObject({ removedAt: null })
    expect(Number(finalDelivery.items.find(item => item.productId === firstProductId)!.shippedQty)).toBe(0)
    expect(finalDelivery.items.find(item => item.productId === secondProductId)!.removedAt).toBeInstanceOf(Date)
    const addedDeliveryItem = finalDelivery.items.find(item => item.productId === addedProductId)!
    expect(addedDeliveryItem.purchaseOrderItemId).not.toBeNull()
    expect(Number(addedDeliveryItem.shippedQty)).toBe(5)
    expect(await prisma.purchaseOrderItem.count({ where: { purchaseOrderId: order.id } })).toBe(3)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERING')
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: addedProductId } })).stock)).toBe(15)

    const replay = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload: shipPayload,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ duplicated: true, deliveryId: saved.json().deliveryId })
    expect(await prisma.deliveryOrder.count({ where: { purchaseOrderId: order.id } })).toBe(1)
    expect(await prisma.supplierStockMovement.count({
      where: { tenantId, sourceType: 'DeliveryOrder', sourceId: saved.json().deliveryId },
    })).toBe(1)
  })

  it('keeps the no-draft legacy ship request compatible', async () => {
    const order = await createAndConfirm([firstProductId])
    const payload = {
      idempotencyKey: `legacy-ship-${suffix}`,
      items: [{ itemId: order.items[0].id, shippedQty: 1 }],
    }
    const shipped = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload,
    })
    expect(shipped.statusCode).toBe(200)
    expect(shipped.json().deliveryNo).toMatch(/^DO\d+$/)
    const replay = await app.inject({
      method: 'PATCH', url: `/api/orders/${order.id}/ship`, headers: { 'x-test-actor': 'supplier' }, payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ duplicated: true, deliveryId: shipped.json().deliveryId })
  })
})
