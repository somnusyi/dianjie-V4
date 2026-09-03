import Fastify from 'fastify'
import { Prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryAddItemBodySchema, deliveryRoutes } from '../../src/routes/deliveries'
import {
  changeDeliveryItemQuantityInTransaction,
  customDeliveryLinePrice,
  removeDeliveryItemInTransaction,
} from '../../src/services/deliveryItemRemoval'

const formalDeliveryStatuses = ['SHIPPED', 'DELIVERED', 'RECEIVED']

function deliveryForAggregationTest() {
  return {
    id: 'delivery-id',
    no: 'DO-TEST',
    tenantId: 'tenant-test',
    supplierId: 'supplier-test',
    purchaseOrderId: 'order-id',
    warehouseId: null,
    status: 'SHIPPED',
    rowVersion: 3,
    actualTotalAmount: new Prisma.Decimal(10),
    receipt: null,
    purchaseOrder: {
      id: 'order-id',
      no: 'PO-TEST',
      supplierId: 'supplier-test',
      status: 'DELIVERING',
      rowVersion: 4,
      totalAmount: new Prisma.Decimal(10),
      supplier: {
        id: 'supplier-test',
        sourceType: null,
        inventoryMode: 'NOT_TRACKED',
        name: '测试供应商',
      },
      items: [{
        id: 'order-item-id',
        productId: 'product-id',
        quantity: new Prisma.Decimal(1),
        shippedQty: new Prisma.Decimal(1),
        amount: new Prisma.Decimal(10),
      }],
    },
    items: [{
      id: 'delivery-item-id',
      purchaseOrderItemId: 'order-item-id',
      productId: 'product-id',
      orderedQtySnapshot: new Prisma.Decimal(1),
      shippedQty: new Prisma.Decimal(1),
      receivedQty: null,
      unitPriceSnapshot: new Prisma.Decimal(10),
      amount: new Prisma.Decimal(10),
      removedAt: null,
      productNameSnapshot: '测试商品',
      productUnitSnapshot: 'kg',
      product: { id: 'product-id', name: '测试商品', unit: 'kg' },
    }],
  }
}

function mutationTxForAggregationTest() {
  const delivery = deliveryForAggregationTest()
  const linkedFindMany = vi.fn()
    .mockResolvedValueOnce([{ amount: new Prisma.Decimal(20) }])
    .mockResolvedValueOnce([{ shippedQty: new Prisma.Decimal(2), amount: new Prisma.Decimal(20) }])
  const tx = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: delivery.id, purchaseOrderId: delivery.purchaseOrderId }])
      .mockResolvedValueOnce([]),
    deliveryOrder: {
      findUnique: vi.fn().mockResolvedValue(delivery),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    deliveryOrderItem: {
      update: vi.fn().mockResolvedValue({}),
      findMany: linkedFindMany,
    },
    purchaseOrderItem: {
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ amount: new Prisma.Decimal(20) }]),
    },
    purchaseOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    deliveryOrderEvent: { create: vi.fn().mockResolvedValue({}) },
    opLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return { tx: tx as any, linkedFindMany }
}

describe('delivery add-item amount safety', () => {
  it('rejects a custom unit price with more than two decimal places', () => {
    const parsed = deliveryAddItemBodySchema.safeParse({
      customProduct: { name: '测试商品', unit: '件', unitPrice: 12.345 },
      quantity: 2,
      rowVersion: 0,
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].message).toBe('商品价格最多保留 2 位小数')
  })

  it('calculates amount from the frozen two-decimal custom unit price', () => {
    const priced = customDeliveryLinePrice(new Prisma.Decimal(3), new Prisma.Decimal('1.235'))

    expect(priced.unitPrice.toFixed(2)).toBe('1.24')
    expect(priced.amount.toFixed(2)).toBe('3.72')
  })
})

describe('delivery item removal safety boundary', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('rejects store-side access before touching a delivery', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'MANAGER',
        supplierId: null,
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    expect(app.printRoutes()).toContain('remove-item')
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/delivery-id/remove-item',
      payload: { itemId: 'item-id', rowVersion: 0 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '仅内部供应链可调整配送商品' })
  })

  it('does not allow any supplier account to mutate delivery items', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLIER_OWNER',
        supplierId: 'supplier-test',
      }
    })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    for (const mutation of [
      { method: 'PATCH' as const, url: '/api/deliveries/delivery-id/remove-item', payload: { itemId: 'item-id', rowVersion: 0 } },
      { method: 'PATCH' as const, url: '/api/deliveries/delivery-id/item-quantity', payload: { itemId: 'item-id', targetQuantity: 2, rowVersion: 0 } },
      { method: 'POST' as const, url: '/api/deliveries/delivery-id/add-item', payload: { productId: 'product-id', quantity: 1, rowVersion: 0 } },
    ]) {
      const response = await app.inject(mutation)
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: '仅内部供应链可调整配送商品' })
    }
  })
})

describe('delivery mutation formal-document aggregation', () => {
  const input = {
    tenantId: 'tenant-test',
    supplierId: 'supplier-test',
    deliveryOrderId: 'delivery-id',
    itemId: 'delivery-item-id',
    userId: 'user-test',
    userRole: 'SUPPLY_CHAIN',
    rowVersion: 3,
  }

  it('excludes internal drafts when removal recomputes a purchase-order line', async () => {
    const { tx, linkedFindMany } = mutationTxForAggregationTest()

    await removeDeliveryItemInTransaction(tx, input)

    expect(linkedFindMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        purchaseOrderItemId: 'order-item-id',
        deliveryOrder: {
          purchaseOrderId: 'order-id',
          status: { in: formalDeliveryStatuses },
        },
        shippedQty: { gt: 0 },
      },
    })
  })

  it('excludes internal drafts when a quantity edit recomputes a purchase-order line', async () => {
    const { tx, linkedFindMany } = mutationTxForAggregationTest()

    await changeDeliveryItemQuantityInTransaction(tx, {
      ...input,
      targetQuantity: new Prisma.Decimal(2),
    })

    expect(linkedFindMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        purchaseOrderItemId: 'order-item-id',
        deliveryOrder: {
          purchaseOrderId: 'order-id',
          status: { in: formalDeliveryStatuses },
        },
        shippedQty: { gt: 0 },
      },
    })
  })
})
