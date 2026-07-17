import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { productRoutes } from '../../src/routes/products'
import { supplierStockRoutes } from '../../src/routes/supplierStock'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
import { reconciliationRoutes } from '../../src/routes/reconciliations'

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
    await prisma.documentDecision.deleteMany({ where: { document: { tenantId } } })
    await prisma.documentStep.deleteMany({ where: { document: { tenantId } } })
    await prisma.document.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
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

  it('cannot list or open supplier B orders and deliveries', async () => {
    const orders = await app.inject({ method: 'GET', url: '/api/orders?page=1&pageSize=100' })
    expect(orders.statusCode).toBe(200)
    expect(orders.json().items).toEqual([])

    const order = await app.inject({ method: 'GET', url: `/api/orders/${orderBId}` })
    expect(order.statusCode).toBe(404)
    const delivery = await app.inject({ method: 'GET', url: `/api/deliveries/${deliveryBId}` })
    expect(delivery.statusCode).toBe(404)
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

  it('keeps product, order and delivery offset pages stable when timestamps tie', async () => {
    const tiedAt = new Date('2026-07-18T00:00:00.000Z')
    const productIds = [`stable-product-a-${suffix}`, `stable-product-b-${suffix}`]
    const orderIds = [`stable-order-a-${suffix}`, `stable-order-b-${suffix}`]
    const deliveryIds = [`stable-delivery-a-${suffix}`, `stable-delivery-b-${suffix}`]
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

    const cases = [
      { endpoint: '/api/products?q=STABLE-PRODUCT', expected: [...productIds].sort() },
      { endpoint: '/api/orders?keyword=STABLE-ORDER', expected: [...orderIds].sort().reverse() },
      { endpoint: '/api/deliveries?keyword=STABLE-DELIVERY', expected: [...deliveryIds].sort().reverse() },
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
  })
})
