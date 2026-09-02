import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'

const suffix = `order-direct-revision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let storeUserId = ''
let supplierUserId = ''
let supplyChainUserId = ''
let baseProductId = ''
let reusableProductId = ''
let app: ReturnType<typeof Fastify>

async function createOrder(expectedDate: string, key: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { 'x-test-actor': 'store' },
    payload: {
      storeId, supplierId, expectedDate, idempotencyKey: key,
      items: [{ productId: baseProductId, quantity: 1, unitPrice: 999 }],
    },
  })
  expect(response.statusCode).toBe(200)
  return response.json()
}

describe('internal operation-group direct revision (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `操作组直改测试 ${suffix}`, slug: suffix },
    })
    tenantId = tenant.id
    const [supplier, store] = await Promise.all([
      prisma.supplier.create({
        data: {
          tenantId, no: `SUP-${suffix}`, name: '操作组直改供应商',
          inventoryMode: 'NOT_TRACKED',
        },
      }),
      prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '操作组直改门店' } }),
    ])
    supplierId = supplier.id
    storeId = store.id
    const [storeUser, supplierUser, supplyChainUser] = await Promise.all([
      prisma.user.create({
        data: {
          tenantId, storeId, storeIds: [storeId], name: '直改测试门店',
          email: `store-${suffix}@local.test`, password: 'test-only', role: 'KITCHEN_LEAD',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, supplierId, name: '直改测试供应商',
          email: `supplier-${suffix}@local.test`, password: 'test-only', role: 'SUPPLIER_OWNER',
        },
      }),
      prisma.user.create({
        data: {
          tenantId, name: '直改测试供应链',
          email: `supply-chain-${suffix}@local.test`, password: 'test-only', role: 'SUPPLY_CHAIN',
        },
      }),
    ])
    storeUserId = storeUser.id
    supplierUserId = supplierUser.id
    supplyChainUserId = supplyChainUser.id
    const [baseProduct, reusableProduct] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `BASE-${suffix}`, name: '原始菌菇', category: '菌菇',
          unit: '斤', purchaseUnit: '斤', inventoryUnit: '斤', orderUnit: '斤', costUnit: '斤',
          inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1,
          inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED',
          price: 10, stock: 0, minOrderQty: 1, stepQty: 1, status: 'ENABLED',
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `REUSE-${suffix}`, name: '已有安全商品', spec: '500g/袋',
          category: '其他', unit: '袋', purchaseUnit: '袋', inventoryUnit: '袋', orderUnit: '袋', costUnit: '袋',
          inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1,
          inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED',
          price: 7.5, pricingMode: 'FIXED', stock: 0, minOrderQty: 0.01, stepQty: 0.01,
          status: 'ENABLED',
        },
      }),
    ])
    baseProductId = baseProduct.id
    reusableProductId = reusableProduct.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supply-chain')
      request.user = actor === 'supplier'
        ? { tenantId, supplierId, userId: supplierUserId, role: 'SUPPLIER_OWNER' }
        : actor === 'store'
          ? { tenantId, storeId, storeIds: [storeId], userId: storeUserId, role: 'KITCHEN_LEAD' }
          : { tenantId, supplierId: null, userId: supplyChainUserId, role: 'SUPPLY_CHAIN' }
    })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.notification.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderRevision.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('applies a catalog/custom-item revision immediately, reuses safe product data, and remains replayable after accept', async () => {
    const first = await createOrder('2026-12-28', `direct-first-${suffix}`)
    const second = await createOrder('2026-12-28', `direct-second-${suffix}`)
    const list = await app.inject({
      method: 'GET', url: '/api/orders?status=SUBMITTED&pageSize=100',
      headers: { 'x-test-actor': 'supply-chain' },
    })
    expect(list.statusCode).toBe(200)
    const grouped = list.json().items.find((item: any) => item.id === second.id || item.id === first.id)
    const group = grouped.operationGroup
    expect(group.memberOrderIds).toEqual(expect.arrayContaining([first.id, second.id]))
    const latestOrderId = group.memberOrderIds[group.memberOrderIds.length - 1]
    const latest = latestOrderId === first.id ? first : second
    const originalSnapshot = structuredClone(latest.submittedSnapshot)
    const originalSnapshotHash = latest.submittedSnapshotHash
    const requestKey = `direct-revision-${suffix}`
    const payload = {
      operationGroupId: group.id,
      reason: '接单时直接调整商品',
      baseRowVersion: latest.rowVersion,
      requestKey,
      items: [
        { productId: baseProductId, quantity: 3 },
        {
          customProduct: { name: '已有安全商品', spec: '500g/袋', unit: '袋', unitPrice: 7.5 },
          quantity: 2,
        },
        {
          customProduct: { name: '临时新品', spec: '', unit: '件', unitPrice: 12.34 },
          quantity: 1.5,
        },
      ],
    }
    const direct = await app.inject({
      method: 'POST', url: `/api/orders/${latest.id}/revisions`,
      headers: { 'x-test-actor': 'supply-chain' }, payload,
    })
    expect(direct.statusCode).toBe(201)
    expect(direct.json()).toMatchObject({ status: 'APPROVED', directApplied: true, duplicated: false })

    const [order, revision, newProduct, reusedCount, pendingCount] = await Promise.all([
      prisma.purchaseOrder.findUniqueOrThrow({
        where: { id: latest.id }, include: { items: { where: { isActive: true } } },
      }),
      prisma.purchaseOrderRevision.findUniqueOrThrow({ where: { id: direct.json().id } }),
      prisma.product.findFirstOrThrow({ where: { tenantId, supplierId, name: '临时新品' } }),
      prisma.product.count({
        where: { tenantId, supplierId, name: '已有安全商品', spec: '500g/袋', unit: '袋', price: 7.5 },
      }),
      prisma.purchaseOrderRevision.count({ where: { purchaseOrderId: latest.id, status: 'PENDING' } }),
    ])
    expect(revision).toMatchObject({
      status: 'APPROVED', requestedById: supplyChainUserId, reviewedById: supplyChainUserId,
      baseRowVersion: latest.rowVersion,
    })
    expect(revision.reviewedAt).toBeInstanceOf(Date)
    expect(order.rowVersion).toBe(latest.rowVersion + 1)
    expect(order.currentRevisionNo).toBe(revision.revisionNo)
    expect(order.currentOrderAmount?.toString()).toBe('63.51')
    expect(order.items).toHaveLength(3)
    expect(order.submittedSnapshot).toEqual(originalSnapshot)
    expect(order.submittedSnapshotHash).toBe(originalSnapshotHash)
    expect(pendingCount).toBe(0)
    expect(reusedCount).toBe(1)
    expect(order.items.some(item => item.productId === reusableProductId)).toBe(true)
    expect(newProduct).toMatchObject({
      spec: null, unit: '件', purchaseUnit: '件', inventoryUnit: '件', orderUnit: '件', costUnit: '件',
      unitConversionStatus: 'VERIFIED', status: 'ENABLED', pricingMode: 'FIXED',
    })
    expect(newProduct.price.toString()).toBe('12.34')
    expect(newProduct.inventoryUnitsPerPurchaseUnit?.toString()).toBe('1')
    expect(newProduct.inventoryUnitsPerOrderUnit?.toString()).toBe('1')
    expect(newProduct.inventoryUnitsPerCostUnit?.toString()).toBe('1')
    const customLine = order.items.find(item => item.productId === newProduct.id)!
    expect(customLine).toMatchObject({
      lineOrigin: 'APPROVED_REVISION', purchaseUnitSnapshot: '件', inventoryUnitSnapshot: '件',
      orderUnitSnapshot: '件', costUnitSnapshot: '件', unitConversionStatusSnapshot: 'VERIFIED',
    })
    expect(customLine.quantity.toString()).toBe('1.5')
    expect(customLine.unitPrice.toString()).toBe('12.34')
    expect(customLine.amount.toString()).toBe('18.51')
    expect(await prisma.purchaseOrderEvent.count({
      where: { purchaseOrderId: latest.id, eventType: { in: ['REVISION_REQUESTED', 'REVISION_APPROVED'] } },
    })).toBe(2)

    const accepted = await app.inject({
      method: 'POST', url: `/api/orders/operation-groups/${group.id}/confirm`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { orderIds: group.memberOrderIds, idempotencyKey: `direct-confirm-${suffix}` },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().confirmedOrderIds).toEqual(expect.arrayContaining(group.memberOrderIds))

    const replay = await app.inject({
      method: 'POST', url: `/api/orders/${latest.id}/revisions`,
      headers: { 'x-test-actor': 'supply-chain' }, payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ id: revision.id, status: 'APPROVED', directApplied: true, duplicated: true })
    expect(await prisma.product.count({ where: { tenantId, supplierId, name: '临时新品' } })).toBe(1)

    const conflictingReplay = await app.inject({
      method: 'POST', url: `/api/orders/${latest.id}/revisions`,
      headers: { 'x-test-actor': 'supply-chain' },
      payload: { ...payload, items: [{ productId: baseProductId, quantity: 4 }] },
    })
    expect(conflictingReplay.statusCode).toBe(409)

    const supplierForgery = await app.inject({
      method: 'POST', url: `/api/orders/${latest.id}/revisions`,
      headers: { 'x-test-actor': 'supplier' }, payload,
    })
    expect(supplierForgery.statusCode).toBe(403)
  })

  it('keeps the supplier single-order revision pending and rejects custom items outside an internal group', async () => {
    const order = await createOrder('2026-12-30', `legacy-order-${suffix}`)
    const pending = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`,
      headers: { 'x-test-actor': 'supplier' },
      payload: {
        reason: '供应商保留旧改单流程', baseRowVersion: order.rowVersion,
        requestKey: `legacy-revision-${suffix}`,
        items: [{ productId: baseProductId, quantity: 2 }],
      },
    })
    expect(pending.statusCode).toBe(201)
    expect(pending.json()).toMatchObject({ status: 'PENDING', requestedById: supplierUserId })
    const unchanged = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id }, include: { items: { where: { isActive: true } } },
    })
    expect(unchanged.rowVersion).toBe(order.rowVersion)
    expect(unchanged.items[0].quantity.toString()).toBe('1')

    const customWithoutGroup = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/revisions`,
      headers: { 'x-test-actor': 'supplier' },
      payload: {
        reason: '试图增加自定义商品', baseRowVersion: order.rowVersion,
        requestKey: `legacy-custom-${suffix}`,
        items: [{ customProduct: { name: '越权商品', unit: '件', unitPrice: 1 }, quantity: 1 }],
      },
    })
    expect(customWithoutGroup.statusCode).toBe(400)
    expect(customWithoutGroup.json().error).toContain('自定义商品仅支持')
  })
})
