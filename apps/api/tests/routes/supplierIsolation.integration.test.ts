import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { productRoutes } from '../../src/routes/products'
import { supplierStockRoutes } from '../../src/routes/supplierStock'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
import { reconciliationRoutes } from '../../src/routes/reconciliations'
import { receiptRoutes } from '../../src/routes/receipts'
import { inventoryRoutes } from '../../src/routes/inventory'

const suffix = `supplier-isolation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierAId = ''
let supplierBId = ''
let userAId = ''
let chefUserId = ''
let storeId = ''
let productAId = ''
let productBId = ''
let orderBId = ''
let deliveryBId = ''
let receiptBId = ''
let app: ReturnType<typeof Fastify>

describe('supplier tenant scope (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `供应商隔离测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const [supplierA, supplierB, store] = await Promise.all([
      prisma.supplier.create({ data: { tenantId, no: `A-${suffix}`, name: '隔离供应商 A' } }),
      prisma.supplier.create({ data: { tenantId, no: `B-${suffix}`, name: '隔离供应商 B' } }),
      prisma.store.create({ data: { tenantId, no: `S-${suffix}`, name: '隔离测试门店' } }),
    ])
    supplierAId = supplierA.id
    supplierBId = supplierB.id
    storeId = store.id
    const [userA, userB, chef] = await Promise.all([
      prisma.user.create({ data: { tenantId, supplierId: supplierA.id, name: '供应商 A 账号', email: `a-${suffix}@local.test`, password: 'test-only', role: 'SUPPLIER_OWNER' } }),
      prisma.user.create({ data: { tenantId, supplierId: supplierB.id, name: '供应商 B 账号', email: `b-${suffix}@local.test`, password: 'test-only', role: 'SUPPLIER_OWNER' } }),
      prisma.user.create({ data: { tenantId, storeId: store.id, storeIds: [store.id], name: '隔离测试厨师长', email: `chef-${suffix}@local.test`, password: 'test-only', role: 'KITCHEN_LEAD' } }),
    ])
    userAId = userA.id
    chefUserId = chef.id
    const [productA, productB] = await Promise.all([
      prisma.product.create({ data: { tenantId, supplierId: supplierA.id, code: `A-P-${suffix}`, name: 'A 商品', price: 10, stock: 11 } }),
      prisma.product.create({ data: { tenantId, supplierId: supplierB.id, code: `B-P-${suffix}`, name: 'B 商品', price: 20, stock: 22 } }),
    ])
    productAId = productA.id
    productBId = productB.id
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId: supplierA.id, productId: productA.id,
        batchNo: `OPENING-A-${suffix}`, kind: 'OPENING',
        initialQty: 11, remainingQty: 11, createdById: userA.id,
      },
    })
    await prisma.product.create({
      data: {
        tenantId, supplierId: supplierB.id, code: `B-PENDING-${suffix}`,
        name: 'B 待审商品', price: 30, stock: 3, status: 'PENDING_APPROVAL',
      },
    })
    const orderB = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-B-${suffix}`, storeId: store.id, supplierId: supplierB.id,
        expectedDate: new Date(), totalAmount: 40, status: 'CONFIRMED', createdById: chef.id,
        items: { create: { productId: productB.id, quantity: 2, unitPrice: 20, amount: 40 } },
      },
      include: { items: true },
    })
    orderBId = orderB.id
    const deliveryB = await prisma.deliveryOrder.create({
      data: {
        tenantId, no: `DO-B-${suffix}`, purchaseOrderId: orderB.id, storeId: store.id,
        supplierId: supplierB.id, actualTotalAmount: 40, status: 'SHIPPED', createdById: userB.id,
        items: {
          create: {
            purchaseOrderItemId: orderB.items[0].id, productId: productB.id,
            orderedQtySnapshot: 2, shippedQty: 2, unitPriceSnapshot: 20, amount: 40,
          },
        },
      },
    })
    deliveryBId = deliveryB.id
    const receiptB = await prisma.receipt.create({
      data: {
        tenantId, no: `RK-B-${suffix}`, storeId: store.id, supplierId: supplierB.id,
        deliveryDate: new Date(), totalAmount: 40, status: 'ACCOUNTED', createdById: chef.id,
        confirmedAt: new Date(), purchaseOrderId: orderB.id, deliveryOrderId: deliveryB.id,
      },
    })
    receiptBId = receiptB.id
    await prisma.paymentSchedule.create({
      data: {
        tenantId, receiptId: receiptB.id, supplierId: supplierB.id, storeId: store.id,
        amount: 40, creditDays: 30, confirmedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 86_400_000), status: 'PENDING',
      },
    })
    await prisma.lossClaim.create({
      data: {
        tenantId, no: `LC-B-${suffix}`, kind: 'ARRIVAL_DAMAGE', purchaseOrderId: orderB.id,
        storeId: store.id, supplierId: supplierB.id, totalLossAmount: 20,
        description: '供应商 B 到货差异', evidenceImages: [], status: 'PENDING', createdById: chef.id,
        items: { create: { productId: productB.id, orderedQty: 2, receivedQty: 1, lossQty: 1, unitPrice: 20, lossAmount: 20 } },
      },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = String(request.headers['x-test-actor'] || 'supplier') === 'chef'
        ? { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
        : { tenantId, supplierId: supplierAId, userId: userAId, role: 'SUPPLIER_OWNER' }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
    await app.register(reconciliationRoutes, { prefix: '/api/reconciliations' })
    await app.register(receiptRoutes, { prefix: '/api/receipts' })
    await app.register(inventoryRoutes, { prefix: '/api/inventory' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.lossClaimItem.deleteMany({ where: { lossClaim: { tenantId } } })
    await prisma.lossClaim.deleteMany({ where: { tenantId } })
    await prisma.paymentSchedule.deleteMany({ where: { tenantId } })
    await prisma.reconciliationItem.deleteMany({ where: { reconciliation: { tenantId } } })
    await prisma.reconciliation.deleteMany({ where: { tenantId } })
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
    await prisma.receipt.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderRevision.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.stockConsumption.deleteMany({ where: { tenantId } })
    await prisma.inventorySnapshot.deleteMany({ where: { tenantId } })
    await prisma.documentDecision.deleteMany({ where: { document: { tenantId } } })
    await prisma.documentStep.deleteMany({ where: { document: { tenantId } } })
    await prisma.document.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.productBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierProductCategory.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('shows only supplier A catalog and stock', async () => {
    const products = await app.inject({ method: 'GET', url: '/api/products?page=1&pageSize=100' })
    expect(products.statusCode).toBe(200)
    expect(products.json().items.map((item: any) => item.id)).toEqual([productAId])

    const stock = await app.inject({ method: 'GET', url: '/api/supplier/stock' })
    expect(stock.statusCode).toBe(200)
    expect(stock.json().map((item: any) => item.id)).toEqual([productAId])
    expect(stock.json().some((item: any) => item.id === productBId)).toBe(false)
  })

  it('filters supplier products by code and category while rejecting invalid filters', async () => {
    const byCode = await app.inject({
      method: 'GET', url: `/api/products?q=${encodeURIComponent(`A-P-${suffix}`)}&page=1&pageSize=20`,
    })
    expect(byCode.statusCode).toBe(200)
    expect(byCode.json()).toMatchObject({ total: 1, items: [{ id: productAId }] })

    const byCategory = await app.inject({
      method: 'GET', url: `/api/products?category=${encodeURIComponent('其他')}&page=1&pageSize=20`,
    })
    expect(byCategory.statusCode).toBe(200)
    expect(byCategory.json().items.map((item: any) => item.id)).toEqual([productAId])

    const invalidQueries = [
      'status=UNKNOWN',
      `q=${'x'.repeat(81)}`,
      `category=${'x'.repeat(41)}`,
    ]
    for (const query of invalidQueries) {
      const response = await app.inject({ method: 'GET', url: `/api/products?${query}&page=1` })
      expect(response.statusCode).toBe(400)
    }
  })

  it('keeps inbound, adjustment and loss aligned with supplier A batch balances', async () => {
    const denied = await app.inject({
      method: 'POST', url: '/api/supplier/stock/inbound',
      payload: { items: [{ productId: productBId, qty: 1 }] },
    })
    expect(denied.statusCode).toBe(400)

    const inbound = await app.inject({
      method: 'POST', url: '/api/supplier/stock/inbound',
      payload: {
        items: [{
          productId: productAId, qty: 2, batchNo: `INBOUND-A-${suffix}`,
          manufactureDate: '2026-07-17', expiryDate: '2026-07-24',
        }],
      },
    })
    expect(inbound.statusCode).toBe(200)
    const adjust = await app.inject({
      method: 'POST', url: '/api/supplier/stock/adjust',
      payload: { productId: productAId, newQty: 12, reason: '测试盘点差异' },
    })
    expect(adjust.statusCode).toBe(200)
    const loss = await app.inject({
      method: 'POST', url: '/api/supplier/stock/loss',
      payload: { productId: productAId, qty: 2, reason: '测试报损' },
    })
    expect(loss.statusCode).toBe(200)

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productAId } })
    expect(Number(product.stock)).toBe(10)
    const batches = await app.inject({
      method: 'GET', url: `/api/supplier/stock/batches?productId=${productAId}`,
    })
    expect(batches.statusCode).toBe(200)
    expect(batches.json().reduce((sum: number, row: any) => sum + row.remainingQty, 0)).toBe(10)
    expect(batches.json().every((row: any) => row.product.id === productAId)).toBe(true)
    expect(await prisma.supplierStockBatchAllocation.count({ where: { tenantId, productId: productAId } })).toBe(2)

    for (const endpoint of ['reservations', 'batches', 'movements']) {
      const foreignProduct = await app.inject({
        method: 'GET', url: `/api/supplier/stock/${endpoint}?productId=${productBId}`,
      })
      expect(foreignProduct.statusCode).toBe(200)
      expect(foreignProduct.json()).toEqual([])
    }
  })

  it('keeps stock snapshot import supplier-scoped and repeat-safe', async () => {
    const foreign = await app.inject({
      method: 'POST', url: '/api/supplier/stock/import-snapshot',
      payload: { items: [{ name: 'B 商品', qty: 1 }], reason: '跨供应商导入回归' },
    })
    expect(foreign.statusCode).toBe(409)
    expect(foreign.json()).toMatchObject({ code: 'UNMATCHED_STOCK_SKU', unmatchedTotal: 1 })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productBId } })).stock)).toBe(22)

    const duplicate = await app.inject({
      method: 'POST', url: '/api/supplier/stock/import-snapshot',
      payload: {
        items: [{ name: 'A 商品', qty: 9 }, { name: ' A 商品 ', qty: 9 }],
        reason: '重复品名回归',
      },
    })
    expect(duplicate.statusCode).toBe(400)

    const payload = { items: [{ name: 'A 商品', qty: 9 }], reason: '目标库存幂等回归' }
    const adjusted = await app.inject({ method: 'POST', url: '/api/supplier/stock/import-snapshot', payload })
    const repeated = await app.inject({ method: 'POST', url: '/api/supplier/stock/import-snapshot', payload })
    expect(adjusted.statusCode).toBe(200)
    expect(adjusted.json().summary).toMatchObject({ adjusted: 1, skipped: 0, failed: 0 })
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json().summary).toMatchObject({ adjusted: 0, skipped: 1, failed: 0 })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)).toBe(9)

    const restored = await app.inject({
      method: 'POST', url: '/api/supplier/stock/import-snapshot',
      payload: { items: [{ name: 'A 商品', qty: 10 }], reason: '恢复测试库存' },
    })
    expect(restored.statusCode).toBe(200)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)).toBe(10)
    const batches = await prisma.supplierStockBatch.aggregate({
      where: { tenantId, supplierId: supplierAId, productId: productAId }, _sum: { remainingQty: true },
    })
    expect(Number(batches._sum.remainingQty)).toBe(10)
  })

  it('shows every approved supplier offer to stores but hides pending offers', async () => {
    const products = await app.inject({
      method: 'GET', url: '/api/products?page=1&pageSize=100', headers: { 'x-test-actor': 'chef' },
    })
    expect(products.statusCode).toBe(200)
    const rows = products.json().items
    expect(rows.map((item: any) => item.id)).toEqual(expect.arrayContaining([productAId, productBId]))
    expect(rows.every((item: any) => item.status === 'ENABLED')).toBe(true)
    expect(rows.some((item: any) => item.name === 'B 待审商品')).toBe(false)
  })

  it('creates an explicit supplier-offer approval document', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/products',
      payload: { name: 'A 新报价商品', category: '其他', unit: '件', price: 18, shelfDays: 7 },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().status).toBe('PENDING_APPROVAL')
    const document = await prisma.document.findFirstOrThrow({
      where: { tenantId, initiatorId: userAId, payload: { path: ['productId'], equals: response.json().id } },
    })
    expect(document.type).toBe('SUPPLIER_OFFER_CREATE')
  })

  it('rejects product create values beyond database decimal bounds before writes', async () => {
    const invalidBodies = [
      { price: 100_000_000 },
      { stock: 100_000_000 },
      { minStock: 100_000_000 },
      { minOrderQty: 100_000_000 },
      { stepQty: 100_000_000 },
    ]
    for (const [index, fields] of invalidBodies.entries()) {
      const response = await app.inject({
        method: 'POST', url: '/api/products',
        payload: { name: `创建数值边界-${index}-${suffix}`, ...fields },
      })
      expect(response.statusCode).toBe(400)
    }

    const batch = await app.inject({
      method: 'POST', url: '/api/products/batch',
      payload: {
        filename: 'decimal-boundary.xlsx',
        items: [{ name: `批量数值边界-${suffix}`, price: 100_000_000 }],
      },
    })
    expect(batch.statusCode).toBe(201)
    expect(batch.json()).toMatchObject({ total: 1, createdCount: 0, failedCount: 1 })
    expect(await prisma.product.count({
      where: { tenantId, name: { contains: '数值边界' } },
    })).toBe(0)
    await prisma.productBatch.delete({ where: { id: batch.json().batchId } })
  })

  it('submits product fields and a price increase as one atomic command', async () => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/products/${productAId}`,
      payload: { price: 12, spec: '箱/12袋', minOrderQty: 2, stepQty: 2 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ priceChangeStatus: 'PENDING_APPROVAL' })

    const [product, document] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productAId } }),
      prisma.document.findFirstOrThrow({
        where: { tenantId, type: 'PRICE_ADJUSTMENT', payload: { path: ['productId'], equals: productAId } },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    expect(Number(product.price)).toBe(10)
    expect(product.spec).toBe('箱/12袋')
    expect(Number(product.minOrderQty)).toBe(2)
    expect(Number(product.stepQty)).toBe(2)
    expect(document.payload).toMatchObject({ oldPrice: 10, newPrice: 12 })
  })

  it('validates product edits and cannot self-approve a pending offer', async () => {
    const invalidBodies = [
      { price: -1 },
      { minOrderQty: 0 },
      { stepQty: -1 },
      { shelfDays: 3651 },
      { shipUpperPct: 0.99 },
      { shipUpperPct: 10.01 },
      { shipUpperBuffer: -1 },
      { shipUpperBuffer: 10_001 },
      { spec: 'x'.repeat(81) },
    ]
    for (const payload of invalidBodies) {
      const response = await app.inject({ method: 'PATCH', url: `/api/products/${productAId}`, payload })
      expect(response.statusCode).toBe(400)
    }
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).price)).toBe(10)

    const pending = await prisma.product.create({
      data: {
        tenantId, supplierId: supplierAId, code: `PENDING-BYPASS-${suffix}`,
        name: '待审批不可自助启用', price: 1, status: 'PENDING_APPROVAL',
      },
    })
    const directEnable = await app.inject({
      method: 'PATCH', url: `/api/products/${pending.id}`, payload: { status: 'ENABLED' },
    })
    expect(directEnable.statusCode).toBe(400)
    const batchEnable = await app.inject({
      method: 'PATCH', url: '/api/products/batch-status',
      payload: { ids: [pending.id], status: 'ENABLED' },
    })
    expect(batchEnable.statusCode).toBe(400)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      status: 'PENDING_APPROVAL',
    })
  })

  it('rejects a cross-supplier batch status impact preview', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/products/batch-status/preview',
      payload: { ids: [productAId, productBId], status: 'DISABLED' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('无权限')
  })

  it('records isolated batch category and restore operations with bounded history input', async () => {
    for (const limit of ['NaN', '1.5', '201']) {
      const invalid = await app.inject({ method: 'GET', url: `/api/products/history?limit=${limit}` })
      expect(invalid.statusCode).toBe(400)
    }

    const category = await app.inject({
      method: 'POST', url: '/api/products/categories', payload: { name: '批量回归分类' },
    })
    expect(category.statusCode).toBe(201)
    const categorized = await app.inject({
      method: 'PATCH', url: '/api/products/batch-category',
      payload: { ids: [productAId], category: '批量回归分类' },
    })
    expect(categorized.statusCode).toBe(200)
    expect(categorized.json()).toMatchObject({ ok: true, count: 1, category: '批量回归分类' })

    await prisma.product.update({ where: { id: productAId }, data: { status: 'DISABLED' } })
    const restored = await app.inject({
      method: 'PATCH', url: '/api/products/batch-status',
      payload: { ids: [productAId], status: 'ENABLED' },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ ok: true, count: 1, status: 'ENABLED' })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({
      category: '批量回归分类', status: 'ENABLED',
    })

    const hiddenAction = `供应商 B 私有商品操作 ${suffix}`
    await prisma.opLog.create({
      data: {
        tenantId, userId: chefUserId, action: hiddenAction, entityType: 'ProductBatch',
        targetId: supplierBId, metadata: { supplierId: supplierBId, productIds: [productBId] },
      },
    })
    const history = await app.inject({ method: 'GET', url: '/api/products/history?limit=200' })
    expect(history.statusCode).toBe(200)
    const rows = history.json()
    expect(rows.some((row: any) => row.action === hiddenAction)).toBe(false)
    for (const action of ['批量修改商品分类', '批量恢复供应']) {
      const row = rows.find((item: any) => String(item.action).includes(action))
      expect(row).toMatchObject({ operator: '供应商 A 账号' })
      expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)
    }
  })

  it('serializes category sort allocation and stabilizes product history', async () => {
    const categoryNames = [`并发分类A-${suffix.slice(-8)}`, `并发分类B-${suffix.slice(-8)}`]
    const created = await Promise.all(categoryNames.map(name => app.inject({
      method: 'POST', url: '/api/products/categories', payload: { name },
    })))
    expect(created.map(response => response.statusCode)).toEqual([201, 201])
    const categories = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId: supplierAId, name: { in: categoryNames } },
      orderBy: { sortOrder: 'asc' },
    })
    expect(categories).toHaveLength(2)
    expect(new Set(categories.map(category => category.sortOrder)).size).toBe(2)

    const tiedAt = new Date('2031-07-18T00:00:00.000Z')
    const logIds = [`stable-product-log-a-${suffix}`, `stable-product-log-b-${suffix}`]
    await prisma.opLog.createMany({
      data: logIds.map((id, index) => ({
        id, tenantId, userId: userAId, action: `稳定商品历史 ${index}`,
        entityType: 'ProductCategory', targetId: categories[index].id,
        metadata: { supplierId: supplierAId }, createdAt: tiedAt,
      })),
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const history = await app.inject({ method: 'GET', url: '/api/products/history?limit=200' })
      expect(history.statusCode).toBe(200)
      expect(history.json()
        .filter((row: any) => String(row.action).startsWith('稳定商品历史'))
        .map((row: any) => row.id)).toEqual([...logIds].sort().reverse())
    }
  })

  it('does not orphan products during concurrent category rename and assignment', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sourceName = `并发改名前-${attempt}-${suffix.slice(-6)}`
      const targetName = `并发改名后-${attempt}-${suffix.slice(-6)}`
      const source = await app.inject({
        method: 'POST', url: '/api/products/categories', payload: { name: sourceName },
      })
      expect(source.statusCode).toBe(201)
      await prisma.product.update({ where: { id: productAId }, data: { category: '其他' } })

      const [renamed, assigned] = await Promise.all([
        app.inject({
          method: 'PATCH', url: `/api/products/categories/${source.json().id}`,
          payload: { name: targetName },
        }),
        app.inject({
          method: 'PATCH', url: '/api/products/batch-category',
          payload: { ids: [productAId], category: sourceName },
        }),
      ])
      expect(renamed.statusCode).toBe(200)
      expect([200, 400]).toContain(assigned.statusCode)
      expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({
        category: assigned.statusCode === 200 ? targetName : '其他',
      })
      expect(await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId: supplierAId, name: sourceName } },
      })).toBeNull()
    }
  })

  it('isolates upload batches and rejects unauthorized revocation', async () => {
    const tiedAt = new Date('2030-07-18T00:00:00.000Z')
    const supplierABatchIds = [`upload-batch-a-${suffix}`, `upload-batch-b-${suffix}`]
    await prisma.productBatch.createMany({
      data: [
        ...supplierABatchIds.map(id => ({
          id, tenantId, supplierId: supplierAId, uploadedById: userAId,
          filename: 'supplier-a.xlsx', totalRows: 0, createdCount: 0, failedCount: 0, createdAt: tiedAt,
        })),
        {
          id: `foreign-upload-batch-${suffix}`, tenantId, supplierId: supplierBId,
          uploadedById: chefUserId, filename: 'supplier-b.xlsx',
          totalRows: 0, createdCount: 0, failedCount: 0, createdAt: tiedAt,
        },
      ],
    })

    for (let attempt = 0; attempt < 3; attempt++) {
      const batches = await app.inject({ method: 'GET', url: '/api/products/batches' })
      expect(batches.statusCode).toBe(200)
      expect(batches.json().map((row: any) => row.id)).toEqual([...supplierABatchIds].sort().reverse())
    }
    const chefList = await app.inject({
      method: 'GET', url: '/api/products/batches', headers: { 'x-test-actor': 'chef' },
    })
    expect(chefList.statusCode).toBe(403)
    const chefRevoke = await app.inject({
      method: 'PATCH', url: `/api/products/batches/${supplierABatchIds[0]}/revoke`,
      headers: { 'x-test-actor': 'chef' },
    })
    expect(chefRevoke.statusCode).toBe(403)
    expect(await prisma.productBatch.findUniqueOrThrow({ where: { id: supplierABatchIds[0] } })).toMatchObject({
      revokedAt: null,
    })
    const crossSupplierRevoke = await app.inject({
      method: 'PATCH', url: `/api/products/batches/foreign-upload-batch-${suffix}/revoke`,
    })
    expect(crossSupplierRevoke.statusCode).toBe(404)

    const longFilename = await app.inject({
      method: 'POST', url: '/api/products/batch',
      payload: {
        filename: 'x'.repeat(256),
        items: [{ name: '文件名校验商品', price: 1 }],
      },
    })
    expect(longFilename.statusCode).toBe(400)
  })

  it('cannot list or open supplier B orders and deliveries', async () => {
    const orders = await app.inject({ method: 'GET', url: '/api/orders?page=1&pageSize=100' })
    expect(orders.statusCode).toBe(200)
    expect(orders.json().items).toEqual([])

    const order = await app.inject({ method: 'GET', url: `/api/orders/${orderBId}` })
    expect(order.statusCode).toBe(404)
    const delivery = await app.inject({ method: 'GET', url: `/api/deliveries/${deliveryBId}` })
    expect(delivery.statusCode).toBe(404)

    const receipts = await app.inject({ method: 'GET', url: '/api/receipts?page=1&pageSize=100' })
    expect(receipts.statusCode).toBe(200)
    expect(receipts.json()).toMatchObject({ total: 0, items: [] })
    const receipt = await app.inject({ method: 'GET', url: `/api/receipts/${receiptBId}` })
    expect(receipt.statusCode).toBe(404)
    const invalidReceiptStatus = await app.inject({ method: 'GET', url: '/api/receipts?status=UNKNOWN' })
    expect(invalidReceiptStatus.statusCode).toBe(400)
  })

  it('cannot list supplier B arrival claims', async () => {
    const claims = await app.inject({ method: 'GET', url: '/api/loss-claims?page=1&pageSize=100' })
    expect(claims.statusCode).toBe(200)
    expect(claims.json()).toMatchObject({ total: 0, items: [] })
  })

  it('cannot include supplier B receipts in supplier A monthly statement', async () => {
    const month = new Date().toISOString().slice(0, 7)
    const statement = await app.inject({
      method: 'GET', url: `/api/reconciliations/supplier-statement?month=${month}`,
    })
    expect(statement.statusCode).toBe(200)
    expect(statement.json()).toMatchObject({
      supplier: { id: supplierAId },
      summary: { receiptCount: 0, payableAmount: 0 },
      lines: [],
    })
  })

  it('keeps store consumption history scoped, validated and stably ordered', async () => {
    const otherStore = await prisma.store.create({
      data: { tenantId, no: `S-OTHER-${suffix}`, name: '另一隔离测试门店' },
    })
    const tiedDate = new Date()
    tiedDate.setUTCHours(0, 0, 0, 0)
    const tiedCreatedAt = new Date('2030-07-18T00:00:00.000Z')
    const scopedIds = [`stable-consumption-a-${suffix}`, `stable-consumption-b-${suffix}`]
    await prisma.stockConsumption.createMany({
      data: [
        ...scopedIds.map((id, index) => ({
          id, tenantId, storeId, productId: productAId, date: tiedDate, quantity: 1,
          sourceType: 'manual', sourceId: `scoped-${index}-${suffix}`,
          createdById: chefUserId, createdAt: tiedCreatedAt,
        })),
        {
          id: `foreign-consumption-${suffix}`, tenantId, storeId: otherStore.id,
          productId: productAId, date: tiedDate, quantity: 1,
          sourceType: 'manual', sourceId: `foreign-${suffix}`,
          createdById: chefUserId, createdAt: tiedCreatedAt,
        },
      ],
    })

    for (const days of ['0', '366', 'NaN']) {
      const invalid = await app.inject({
        method: 'GET', url: `/api/inventory/consumptions?days=${days}`,
        headers: { 'x-test-actor': 'chef' },
      })
      expect(invalid.statusCode).toBe(400)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/inventory/consumptions?days=30&storeId=${otherStore.id}`,
        headers: { 'x-test-actor': 'chef' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().map((row: any) => row.id)).toEqual([...scopedIds].sort().reverse())
    }
  })

  it('makes concurrent manual consumption retries idempotent', async () => {
    const idempotencyKey = `consume-${suffix}`
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      note: '并发领用回归',
      idempotencyKey,
      items: [{ productId: productAId, quantity: 1.25 }],
    }
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/inventory/consume', payload, headers: { 'x-test-actor': 'chef' } }),
      app.inject({ method: 'POST', url: '/api/inventory/consume', payload, headers: { 'x-test-actor': 'chef' } }),
    ])
    expect(responses.map(response => response.statusCode)).toEqual([200, 200])
    expect(responses.map(response => response.json().duplicated).sort()).toEqual([false, true])
    const operationIds = responses.map(response => response.json().operationId)
    expect(new Set(operationIds).size).toBe(1)
    expect(await prisma.stockConsumption.count({
      where: { tenantId, storeId, sourceType: 'manual', sourceId: operationIds[0] },
    })).toBe(1)
    expect(await prisma.opLog.count({
      where: { tenantId, entityType: 'StockConsumptionBatch', targetId: operationIds[0] },
    })).toBe(1)

    const conflict = await app.inject({
      method: 'POST', url: '/api/inventory/consume', headers: { 'x-test-actor': 'chef' },
      payload: { ...payload, items: [{ productId: productAId, quantity: 2 }] },
    })
    expect(conflict.statusCode).toBe(409)
  })

  it('keeps bound-store snapshot and estimated inventory rows stably ordered', async () => {
    const otherStore = await prisma.store.create({
      data: { tenantId, no: `S-SNAPSHOT-${suffix}`, name: '另一盘点测试门店' },
    })
    const snapshotDate = new Date()
    snapshotDate.setUTCHours(0, 0, 0, 0)
    snapshotDate.setUTCDate(snapshotDate.getUTCDate() - 1)
    const productIds = [`inventory-product-a-${suffix}`, `inventory-product-b-${suffix}`]
    const itemIds = [`inventory-item-a-${suffix}`, `inventory-item-b-${suffix}`]
    await prisma.product.createMany({
      data: productIds.map((id, index) => ({
        id, tenantId, supplierId: supplierAId, code: `INVENTORY-${index}-${suffix}`,
        name: '同名库存商品', unit: '件', price: 2,
      })),
    })
    await prisma.inventorySnapshot.create({
      data: {
        tenantId, storeId, snapshotDate, sourceFilename: 'integration-fixture.xlsx',
        totalValue: 6, itemCount: 2, nonzeroCount: 2, zeroCount: 0, matchedCount: 2,
        items: {
          create: itemIds.map((id, index) => ({
            id, productId: productIds[index], rawName: '同名库存商品', unit: '件',
            quantity: index + 1, unitPrice: 2, amount: (index + 1) * 2,
            normalizationStatus: 'EXACT', normalizedQuantity: index + 1,
            normalizedUnit: '件', sortOrder: 1,
          })),
        },
      },
    })
    await prisma.inventorySnapshot.create({
      data: {
        tenantId, storeId: otherStore.id, snapshotDate, sourceFilename: 'foreign-fixture.xlsx',
        totalValue: 0, itemCount: 0, nonzeroCount: 0, zeroCount: 0, matchedCount: 0,
      },
    })

    for (let attempt = 0; attempt < 3; attempt++) {
      const [snapshot, estimated] = await Promise.all([
        app.inject({
          method: 'GET', url: `/api/inventory/snapshot/latest?storeId=${otherStore.id}`,
          headers: { 'x-test-actor': 'chef' },
        }),
        app.inject({
          method: 'GET', url: `/api/inventory?storeId=${otherStore.id}`,
          headers: { 'x-test-actor': 'chef' },
        }),
      ])
      expect([snapshot.statusCode, estimated.statusCode]).toEqual([200, 200])
      expect(snapshot.json().items.map((row: any) => row.id)).toEqual([...itemIds].sort())
      expect(estimated.json()
        .map((row: any) => row.id)
        .filter((id: string) => productIds.includes(id))).toEqual([...productIds].sort())
    }
  })

  it('cannot export supplier B receipts or differences through supplier A downloads', async () => {
    const month = new Date().toISOString().slice(0, 7)
    const statement = await app.inject({
      method: 'GET', url: `/api/reconciliations/supplier-statement/export?month=${month}`,
    })
    expect(statement.statusCode).toBe(200)
    expect(statement.headers['content-type']).toContain('text/csv')
    expect(statement.body).toContain('入库单')
    expect(statement.body).not.toContain(`RK-B-${suffix}`)

    const differences = await app.inject({
      method: 'GET', url: '/api/loss-claims/export?isManual=false',
    })
    expect(differences.statusCode).toBe(200)
    expect(differences.headers['content-type']).toContain('text/csv')
    expect(differences.body).toContain('差异单号')
    expect(differences.body).not.toContain(`LC-B-${suffix}`)

    const exportLogs = await prisma.opLog.count({
      where: { tenantId, userId: userAId, entityType: { in: ['SupplierStatement', 'LossClaimExport'] } },
    })
    expect(exportLogs).toBe(2)
  })

  it('keeps product, order, delivery and receipt offset pages stable when timestamps tie', async () => {
    const tiedAt = new Date('2026-07-18T00:00:00.000Z')
    const productIds = [`stable-product-a-${suffix}`, `stable-product-b-${suffix}`]
    const orderIds = [`stable-order-a-${suffix}`, `stable-order-b-${suffix}`]
    const deliveryIds = [`stable-delivery-a-${suffix}`, `stable-delivery-b-${suffix}`]
    const receiptIds = [`stable-receipt-a-${suffix}`, `stable-receipt-b-${suffix}`]
    const movementIds = [`stable-movement-a-${suffix}`, `stable-movement-b-${suffix}`]
    await prisma.product.createMany({
      data: productIds.map((id, index) => ({
        id, tenantId, supplierId: supplierAId, code: `STABLE-PRODUCT-${index}-${suffix}`,
        name: `STABLE-PRODUCT-${index}`, price: 1, createdAt: tiedAt,
      })),
    })
    await prisma.purchaseOrder.createMany({
      data: orderIds.map((id, index) => ({
        id, tenantId, no: `STABLE-ORDER-${index}-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: tiedAt, totalAmount: 0, status: 'SUBMITTED', createdById: chefUserId, createdAt: tiedAt,
      })),
    })
    await prisma.deliveryOrder.createMany({
      data: deliveryIds.map((id, index) => ({
        id, tenantId, no: `STABLE-DELIVERY-${index}-${suffix}`, purchaseOrderId: orderIds[index],
        storeId, supplierId: supplierAId, status: 'SHIPPED', actualTotalAmount: 0,
        createdById: userAId, createdAt: tiedAt,
      })),
    })
    await prisma.receipt.createMany({
      data: receiptIds.map((id, index) => ({
        id, tenantId, no: `STABLE-RECEIPT-${index}-${suffix}`, storeId, supplierId: supplierAId,
        deliveryDate: tiedAt, totalAmount: 0, status: 'CONFIRMED', createdById: chefUserId,
        confirmedAt: tiedAt, createdAt: tiedAt,
      })),
    })
    await prisma.supplierStockMovement.createMany({
      data: movementIds.map(id => ({
        id, tenantId, supplierId: supplierAId, productId: productAId,
        delta: 0, balanceAfter: 10, type: 'ADJUSTMENT', reason: '稳定排序回归',
        createdById: userAId, createdAt: new Date('2030-07-18T00:00:00.000Z'),
      })),
    })

    const cases = [
      { endpoint: '/api/products?q=STABLE-PRODUCT', expected: [...productIds].sort() },
      { endpoint: '/api/orders?keyword=STABLE-ORDER', expected: [...orderIds].sort().reverse() },
      { endpoint: '/api/deliveries?keyword=STABLE-DELIVERY', expected: [...deliveryIds].sort().reverse() },
      { endpoint: '/api/receipts?status=CONFIRMED', expected: [...receiptIds].sort().reverse() },
    ]
    for (const testCase of cases) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [first, second] = await Promise.all([
          app.inject({ method: 'GET', url: `${testCase.endpoint}&page=1&pageSize=1` }),
          app.inject({ method: 'GET', url: `${testCase.endpoint}&page=2&pageSize=1` }),
        ])
        expect([first.statusCode, second.statusCode]).toEqual([200, 200])
        expect([first.json().items[0].id, second.json().items[0].id]).toEqual(testCase.expected)
        expect(first.json().total).toBe(2)
        expect(second.json().total).toBe(2)
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const movements = await app.inject({
        method: 'GET', url: `/api/supplier/stock/movements?productId=${productAId}&type=ADJUSTMENT&limit=2`,
      })
      expect(movements.statusCode).toBe(200)
      expect(movements.json().map((row: any) => row.id)).toEqual([...movementIds].sort().reverse())
    }
  })
})
