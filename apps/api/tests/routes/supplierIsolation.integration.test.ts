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
import { dashboardRoutes } from '../../src/routes/dashboard'
import { v2DashboardRoutes } from '../../src/routes/v2Dashboard'
import { storeRoutes } from '../../src/routes/stores'
import { revenueRoutes } from '../../src/routes/revenue'
import { paymentRequestRoutes } from '../../src/routes/paymentRequests'
import { documentRoutes } from '../../src/routes/documents'
import { uploadRoutes } from '../../src/routes/upload'
import { supplierRoutes } from '../../src/routes/suppliers'
import { scheduleRoutes } from '../../src/routes/schedules'

const suffix = `supplier-isolation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierAId = ''
let supplierBId = ''
let userAId = ''
let userBId = ''
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
      prisma.supplier.create({
        data: {
          tenantId, no: `B-${suffix}`, name: '隔离供应商 B',
          bankName: '测试银行', bankAccount: 'sensitive-supplier-account',
          bankAccountName: '隔离供应商 B', bankCode: 'sensitive-bank-code',
          autoPay: true, autoPayLimit: 999,
        },
      }),
      prisma.store.create({
        data: {
          tenantId, no: `S-${suffix}`, name: '隔离测试门店',
          address: '测试配送地址', phone: '13800000000', managerName: '测试店长',
          aggregatorApiKeyEnc: 'sensitive-aggregator-key',
          aggregatorSecretEnc: 'sensitive-aggregator-secret',
          wechatApiV3KeyEnc: 'sensitive-wechat-key',
          alipayPrivateKeyEnc: 'sensitive-alipay-key',
          bankAccountNo: 'sensitive-store-account',
          invoiceTaxId: 'sensitive-tax-id',
        },
      }),
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
    userBId = userB.id
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
        tempSupplierName: '供应商 B 临时名称',
        tempBankAccount: 'sensitive-receipt-account',
        tempBankName: '敏感测试开户行',
      },
    })
    receiptBId = receiptB.id
    await prisma.paymentSchedule.create({
      data: {
        tenantId, receiptId: receiptB.id, supplierId: supplierB.id, storeId: store.id,
        amount: 40, creditDays: 30, confirmedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 86_400_000), status: 'PENDING',
        bankTxNo: 'sensitive-bank-transaction',
        bankRawResponse: { privatePayload: 'sensitive-bank-response' },
        retryCount: 2, failReason: 'sensitive-payment-failure',
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
      const actor = String(request.headers['x-test-actor'] || 'supplier')
      request.user = actor === 'chef'
        ? { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'KITCHEN_LEAD' }
        : actor === 'purchaser'
          ? { tenantId, storeId, storeIds: [storeId], userId: chefUserId, role: 'PURCHASER' }
        : actor === 'unbound-store'
          ? { tenantId, userId: chefUserId, role: 'MANAGER' }
        : actor === 'admin'
          ? { tenantId, userId: chefUserId, role: 'ADMIN' }
          : actor === 'supplier-mismatch'
            ? { tenantId, supplierId: supplierBId, userId: userAId, role: 'SUPPLIER_OWNER' }
          : actor === 'supplier-b'
            ? { tenantId, supplierId: supplierBId, userId: userBId, role: 'SUPPLIER_OWNER' }
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
    await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
    await app.register(v2DashboardRoutes, { prefix: '/api/v2/dashboard' })
    await app.register(storeRoutes, { prefix: '/api/stores' })
    await app.register(revenueRoutes, { prefix: '/api/revenue' })
    await app.register(paymentRequestRoutes, { prefix: '/api/payment-requests' })
    await app.register(documentRoutes, { prefix: '/api/documents' })
    await app.register(uploadRoutes, { prefix: '/api' })
    await app.register(supplierRoutes, { prefix: '/api/suppliers' })
    await app.register(scheduleRoutes, { prefix: '/api/schedules' })
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

  it('rejects a dashboard supplier claim that disagrees with the database binding', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v2/dashboard/me', headers: { 'x-test-actor': 'supplier-mismatch' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toContain('绑定不一致')
  })

  it('counts delivering orders in the supplier-scoped dashboard transit total', async () => {
    const delivering = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-DELIVERING-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: new Date(), totalAmount: 10, status: 'DELIVERING', createdById: chefUserId,
      },
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.supplierExt).toMatchObject({
        submittedCnt: 0,
        confirmedCnt: 0,
        shippedCnt: 1,
      })
      expect(response.json().hero.stats.find((stat: any) => stat.label === '在途订单')).toMatchObject({
        value: '1',
      })
    } finally {
      await prisma.purchaseOrder.delete({ where: { id: delivering.id } })
    }
  })

  it('keeps schedules already marked overdue in the supplier overdue bucket', async () => {
    const receipt = await prisma.receipt.create({
      data: {
        tenantId, no: `RK-OVERDUE-${suffix}`, storeId, supplierId: supplierAId,
        deliveryDate: new Date(), totalAmount: 17, status: 'ACCOUNTED', createdById: chefUserId,
        confirmedAt: new Date(),
      },
    })
    const schedule = await prisma.paymentSchedule.create({
      data: {
        tenantId, receiptId: receipt.id, supplierId: supplierAId, storeId,
        amount: 17, creditDays: 0, confirmedAt: new Date(Date.now() - 2 * 86_400_000),
        dueAt: new Date(Date.now() - 86_400_000), status: 'OVERDUE',
      },
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.supplierExt).toMatchObject({
        arTotal: 17,
        arOverdue: 17,
      })
      expect(response.json().hero.meta).toContain('逾期 ¥17')
    } finally {
      await prisma.paymentSchedule.delete({ where: { id: schedule.id } })
      await prisma.receipt.delete({ where: { id: receipt.id } })
    }
  })

  it('keeps approval and processing receivables while excluding cancelled dues from recovery', async () => {
    const amounts = [5, 6, 100, 20]
    const receipts = await Promise.all(amounts.map((amount, index) => prisma.receipt.create({
      data: {
        tenantId, no: `RK-AR-${index}-${suffix}`, storeId, supplierId: supplierAId,
        deliveryDate: new Date(), totalAmount: amount, status: 'ACCOUNTED',
        createdById: chefUserId, confirmedAt: new Date(),
      },
    })))
    const futureDueAt = new Date(Date.now() + 40 * 86_400_000)
    const currentDueAt = new Date()
    await Promise.all([
      prisma.paymentSchedule.create({
        data: {
          tenantId, receiptId: receipts[0].id, supplierId: supplierAId, storeId,
          amount: amounts[0], creditDays: 40, confirmedAt: new Date(),
          dueAt: futureDueAt, status: 'PENDING_APPROVAL', needApproval: true,
        },
      }),
      prisma.paymentSchedule.create({
        data: {
          tenantId, receiptId: receipts[1].id, supplierId: supplierAId, storeId,
          amount: amounts[1], creditDays: 40, confirmedAt: new Date(),
          dueAt: futureDueAt, status: 'PROCESSING',
        },
      }),
      prisma.paymentSchedule.create({
        data: {
          tenantId, receiptId: receipts[2].id, supplierId: supplierAId, storeId,
          amount: amounts[2], creditDays: 0, confirmedAt: new Date(),
          dueAt: currentDueAt, status: 'CANCELLED',
        },
      }),
      prisma.paymentSchedule.create({
        data: {
          tenantId, receiptId: receipts[3].id, supplierId: supplierAId, storeId,
          amount: amounts[3], creditDays: 0, confirmedAt: new Date(),
          dueAt: currentDueAt, status: 'PAID', paidAt: currentDueAt,
        },
      }),
    ])
    const receiptIds = receipts.map(receipt => receipt.id)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.supplierExt.arTotal).toBe(11)
      expect(response.json().hero.meta).toBe('暂无 7 天内到期')
      expect(response.json().hero.stats.find((stat: any) => stat.label === '回款率')).toMatchObject({
        value: '100%',
      })
    } finally {
      await prisma.paymentSchedule.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await prisma.receipt.deleteMany({ where: { id: { in: receiptIds } } })
    }
  })

  it('uses confirmed receipt value for the supplier monthly delivered metric', async () => {
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-MONTH-DELIVERED-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: new Date(), totalAmount: 100, status: 'RECEIVED', createdById: chefUserId,
      },
    })
    const receipt = await prisma.receipt.create({
      data: {
        tenantId, no: `RK-MONTH-DELIVERED-${suffix}`, storeId, supplierId: supplierAId,
        purchaseOrderId: order.id, deliveryDate: new Date(), totalAmount: 40,
        status: 'CONFIRMED', createdById: chefUserId, confirmedAt: new Date(),
      },
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.stats.find((stat: any) => stat.label === '本月已交付')).toMatchObject({
        value: '¥40',
      })
    } finally {
      await prisma.receipt.delete({ where: { id: receipt.id } })
      await prisma.purchaseOrder.delete({ where: { id: order.id } })
    }
  })

  it('counts only non-depleted expiring batches in the supplier dashboard', async () => {
    const expiryDate = new Date(Date.now() + 2 * 86_400_000)
    const batches = await Promise.all([
      prisma.supplierStockBatch.create({
        data: {
          tenantId, supplierId: supplierAId, productId: productAId,
          batchNo: `EXPIRING-ACTIVE-${suffix}`, kind: 'INBOUND',
          initialQty: 2, remainingQty: 1, expiryDate, createdById: userAId,
        },
      }),
      prisma.supplierStockBatch.create({
        data: {
          tenantId, supplierId: supplierAId, productId: productAId,
          batchNo: `EXPIRING-DEPLETED-${suffix}`, kind: 'INBOUND',
          initialQty: 2, remainingQty: 0, expiryDate, depletedAt: new Date(), createdById: userAId,
        },
      }),
    ])
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.supplierExt.expiringCnt).toBe(1)
    } finally {
      await prisma.supplierStockBatch.deleteMany({ where: { id: { in: batches.map(batch => batch.id) } } })
    }
  })

  it('uses available stock after reservations for the supplier low-stock metric', async () => {
    const before = await prisma.product.findUniqueOrThrow({
      where: { id: productAId },
      select: { minStock: true },
    })
    await prisma.product.update({ where: { id: productAId }, data: { minStock: 10 } })
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-LOW-STOCK-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: new Date(), totalAmount: 20, status: 'CONFIRMED', createdById: chefUserId,
        items: {
          create: {
            productId: productAId, quantity: 2, unitPrice: 10, amount: 20,
          },
        },
      },
      include: { items: true },
    })
    const reservation = await prisma.supplierStockReservation.create({
      data: {
        tenantId, supplierId: supplierAId, productId: productAId,
        purchaseOrderId: order.id, purchaseOrderItemId: order.items[0].id,
        quantity: 2,
      },
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
      expect(response.statusCode).toBe(200)
      expect(response.json().hero.supplierExt.lowStockCnt).toBe(1)
    } finally {
      await prisma.supplierStockReservation.delete({ where: { id: reservation.id } })
      await prisma.purchaseOrder.delete({ where: { id: order.id } })
      await prisma.product.update({ where: { id: productAId }, data: { minStock: before.minStock } })
    }
  })

  it('treats supplier pageSize as pagination and keeps tied pages stable', async () => {
    const headers = { 'x-test-actor': 'admin' }
    const first = await app.inject({
      method: 'GET', url: '/api/suppliers?pageSize=1', headers,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ total: 2, page: 1, pageSize: 1 })
    expect(first.json().items).toHaveLength(1)

    const second = await app.inject({
      method: 'GET', url: '/api/suppliers?page=2&pageSize=1', headers,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ total: 2, page: 2, pageSize: 1 })
    expect(second.json().items).toHaveLength(1)
    expect(new Set([first.json().items[0].id, second.json().items[0].id]))
      .toEqual(new Set([supplierAId, supplierBId]))
  })

  it('validates upload queries and exact tenant object-key scope before OSS access', async () => {
    for (const request of [
      { method: 'POST', url: '/api/upload?category=products&unexpected=true' },
      { method: 'POST', url: '/api/upload?category=UNKNOWN' },
      { method: 'GET', url: `/api/upload/signed-url?key=products/${tenantId}/image.jpg&expires=60seconds` },
      { method: 'GET', url: `/api/upload/signed-url?key=products/${tenantId}/image.jpg&expires=59` },
      { method: 'GET', url: `/api/upload/signed-url?key=products/${tenantId}/image.jpg&unexpected=true` },
    ]) {
      const response = await app.inject(request as any)
      expect(response.statusCode).toBe(400)
    }
    for (const key of [
      `unknown/${tenantId}/image.jpg`,
      `products/foreign-tenant/image.jpg`,
      `products/${tenantId}`,
    ]) {
      const response = await app.inject({
        method: 'GET', url: `/api/upload/signed-url?key=${encodeURIComponent(key)}`,
      })
      expect(response.statusCode).toBe(403)
    }
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
      'all=2',
      'unexpected=true',
    ]
    for (const query of invalidQueries) {
      const response = await app.inject({ method: 'GET', url: `/api/products?${query}&page=1` })
      expect(response.statusCode).toBe(400)
    }

    const legacyAll = await app.inject({ method: 'GET', url: '/api/products?all=1' })
    expect(legacyAll.statusCode).toBe(200)
    expect(legacyAll.json().map((item: any) => item.id)).toEqual([productAId])

    for (const url of [
      '/api/products/categories?unexpected=true',
      '/api/products/history?unexpected=true',
    ]) {
      const response = await app.inject({ method: 'GET', url })
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

  it('rejects unknown supplier stock command fields before writes', async () => {
    const beforeProduct = await prisma.product.findUniqueOrThrow({ where: { id: productAId } })
    const beforeMovements = await prisma.supplierStockMovement.count({ where: { tenantId, productId: productAId } })
    const beforeBatches = await prisma.supplierStockBatch.count({ where: { tenantId, productId: productAId } })
    const requests = [
      { url: '/api/supplier/stock/inbound', payload: { items: [{ productId: productAId, qty: 1 }], unexpected: true } },
      { url: '/api/supplier/stock/inbound', payload: { items: [{ productId: productAId, qty: 1, unexpected: true }] } },
      { url: '/api/supplier/stock/adjust', payload: { productId: productAId, newQty: 8, reason: '严格命令验证', unexpected: true } },
      { url: '/api/supplier/stock/loss', payload: { productId: productAId, qty: 1, reason: '严格命令验证', unexpected: true } },
      { url: '/api/supplier/stock/import-snapshot', payload: { items: [{ name: 'A 商品', qty: 8 }], unexpected: true } },
      { url: '/api/supplier/stock/import-snapshot', payload: { items: [{ name: 'A 商品', qty: 8, unexpected: true }] } },
    ]
    for (const request of requests) {
      const response = await app.inject({ method: 'POST', ...request })
      expect(response.statusCode).toBe(400)
    }
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({ stock: beforeProduct.stock })
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, productId: productAId } })).toBe(beforeMovements)
    expect(await prisma.supplierStockBatch.count({ where: { tenantId, productId: productAId } })).toBe(beforeBatches)
  })

  it('validates supplier stock read query contracts before database reads', async () => {
    const invalidQueries = [
      '/api/supplier/stock?unexpected=true',
      '/api/supplier/stock/summary?unexpected=true',
      '/api/supplier/stock/reservations?unexpected=true',
      '/api/supplier/stock/batches?unexpected=true',
      '/api/supplier/stock/movements?unexpected=true',
      '/api/supplier/stock/reservations?productId=',
      '/api/supplier/stock/batches?productId=',
      '/api/supplier/stock/movements?productId=',
      `/api/supplier/stock/reservations?productId=${'x'.repeat(101)}`,
      `/api/supplier/stock/batches?productId=${'x'.repeat(101)}`,
      `/api/supplier/stock/movements?productId=${'x'.repeat(101)}`,
    ]
    for (const url of invalidQueries) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(400)
    }
  })

  it('serializes custom inbound batch numbers without partial stock writes', async () => {
    const beforeStock = Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)
    const duplicateInRequest = await app.inject({
      method: 'POST', url: '/api/supplier/stock/inbound',
      payload: {
        items: [
          { productId: productAId, qty: 1, batchNo: `DUP-IN-${suffix}` },
          { productId: productAId, qty: 1, batchNo: ` DUP-IN-${suffix} ` },
        ],
      },
    })
    expect(duplicateInRequest.statusCode).toBe(400)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)).toBe(beforeStock)

    const batchNo = `CONCURRENT-IN-${suffix}`
    const payload = { items: [{ productId: productAId, qty: 1, batchNo }] }
    const attempts = await Promise.all([1, 2].map(() => app.inject({
      method: 'POST', url: '/api/supplier/stock/inbound', payload,
    })))
    expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 409])
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)).toBe(beforeStock + 1)
    const batch = await prisma.supplierStockBatch.findUniqueOrThrow({
      where: { tenantId_productId_batchNo: { tenantId, productId: productAId, batchNo } },
    })
    expect(Number(batch.remainingQty)).toBe(1)
    expect(await prisma.supplierStockMovement.count({ where: { tenantId, productId: productAId, id: batch.sourceMovementId! } })).toBe(1)

    const repeated = await app.inject({ method: 'POST', url: '/api/supplier/stock/inbound', payload })
    expect(repeated.statusCode).toBe(409)
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).stock)).toBe(beforeStock + 1)

    await prisma.$transaction([
      prisma.supplierStockBatch.delete({ where: { id: batch.id } }),
      prisma.supplierStockMovement.delete({ where: { id: batch.sourceMovementId! } }),
      prisma.product.update({ where: { id: productAId }, data: { stock: beforeStock } }),
    ])
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

  it('rejects silently ignored or scope-changing product patch fields before writes', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productAId } })
    for (const request of [
      { payload: { stock: 999 }, headers: {} },
      { payload: { name: '供应商不可改名' }, headers: {} },
      { payload: { unexpected: true }, headers: {} },
      { payload: { supplierId: supplierBId }, headers: { 'x-test-actor': 'admin' } },
    ]) {
      const response = await app.inject({
        method: 'PATCH', url: `/api/products/${productAId}`,
        payload: request.payload, headers: request.headers,
      })
      expect(response.statusCode).toBe(400)
    }
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({
      name: before.name,
      supplierId: before.supplierId,
      stock: before.stock,
    })

    const valid = await app.inject({
      method: 'PATCH', url: `/api/products/${productAId}`, payload: { spec: '严格字段回归' },
    })
    expect(valid.statusCode).toBe(200)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({
      spec: '严格字段回归',
    })
  })

  it('rejects unknown category, import and bulk command fields before writes', async () => {
    const categoryName = `严格命令分类-${suffix.slice(-8)}`
    const beforeBatchCount = await prisma.productBatch.count({ where: { tenantId } })
    const beforeProduct = await prisma.product.findUniqueOrThrow({ where: { id: productAId } })

    const invalidCreate = await app.inject({
      method: 'POST', url: '/api/products/categories',
      payload: { name: categoryName, unexpected: true },
    })
    expect(invalidCreate.statusCode).toBe(400)
    expect(await prisma.supplierProductCategory.count({ where: { tenantId, supplierId: supplierAId, name: categoryName } })).toBe(0)

    const category = await app.inject({
      method: 'POST', url: '/api/products/categories', payload: { name: categoryName },
    })
    expect(category.statusCode).toBe(201)
    try {
      const categoryIds = (await prisma.supplierProductCategory.findMany({
        where: { tenantId, supplierId: supplierAId }, select: { id: true },
      })).map(row => row.id)
      const requests = [
        { method: 'PATCH', url: `/api/products/categories/${category.json().id}`, payload: { isActive: false, unexpected: true } },
        { method: 'PATCH', url: '/api/products/categories-order', payload: { ids: categoryIds, unexpected: true } },
        { method: 'POST', url: '/api/products/batch-status/preview', payload: { ids: [productAId], status: 'DISABLED', unexpected: true } },
        { method: 'PATCH', url: '/api/products/batch-category', payload: { ids: [productAId], category: categoryName, unexpected: true } },
        { method: 'PATCH', url: '/api/products/batch-status', payload: { ids: [productAId], status: 'DISABLED', unexpected: true } },
        {
          method: 'POST', url: '/api/products/batch',
          payload: { filename: 'strict-envelope.xlsx', items: [{ name: '不应创建的商品', price: 1 }], unexpected: true },
        },
      ]
      for (const request of requests) {
        const response = await app.inject(request as any)
        expect(response.statusCode).toBe(400)
      }
      expect(await prisma.supplierProductCategory.findUniqueOrThrow({ where: { id: category.json().id } })).toMatchObject({ isActive: true })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: productAId } })).toMatchObject({
        category: beforeProduct.category,
        status: beforeProduct.status,
      })
      expect(await prisma.productBatch.count({ where: { tenantId } })).toBe(beforeBatchCount)
    } finally {
      await prisma.opLog.deleteMany({ where: { tenantId, targetId: category.json().id } })
      await prisma.supplierProductCategory.deleteMany({ where: { id: category.json().id } })
    }
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

    const importCategories = Array.from({ length: 4 }, (_, index) => `并发导入分类${index}-${suffix.slice(-8)}`)
    const imported = await Promise.all(importCategories.map((category, index) => app.inject({
      method: 'POST', url: '/api/products/batch',
      payload: {
        filename: `concurrent-category-${index}.xlsx`,
        items: [{
          code: `CAT-IMP-${index}-${suffix.slice(-8)}`, name: `并发分类导入商品 ${index}`,
          category, unit: '件', price: 10 + index,
        }],
      },
    })))
    expect(imported.map(response => response.statusCode)).toEqual([201, 201, 201, 201])
    expect(imported.every(response => response.json().createdCount === 1)).toBe(true)
    const importedCategories = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId: supplierAId, name: { in: importCategories } },
      orderBy: { sortOrder: 'asc' },
    })
    expect(importedCategories).toHaveLength(importCategories.length)
    expect(new Set(importedCategories.map(category => category.sortOrder)).size).toBe(importCategories.length)
    const importBatchIds = imported.map(response => response.json().batchId as string)
    const importProductIds = imported.flatMap(response => response.json().created.map((item: any) => item.id as string))
    await prisma.document.deleteMany({
      where: { tenantId, no: { in: imported.map(response => response.json().approvalDocNo as string) } },
    })
    await prisma.opLog.deleteMany({ where: { targetId: { in: importBatchIds } } })
    await prisma.product.deleteMany({ where: { id: { in: importProductIds } } })
    await prisma.productBatch.deleteMany({ where: { id: { in: importBatchIds } } })
    await prisma.supplierProductCategory.deleteMany({ where: { id: { in: importedCategories.map(category => category.id) } } })

    const allCategoryIds = (await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId: supplierAId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true },
    })).map(category => category.id)
    const reorderResults = await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/products/categories-order', payload: { ids: allCategoryIds } }),
      app.inject({ method: 'PATCH', url: '/api/products/categories-order', payload: { ids: [...allCategoryIds].reverse() } }),
    ])
    expect(reorderResults.map(response => response.statusCode)).toEqual([200, 200])
    const reorderedCategories = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId: supplierAId }, select: { sortOrder: true },
    })
    expect(new Set(reorderedCategories.map(category => category.sortOrder)).size).toBe(reorderedCategories.length)

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

  it('does not orphan single-product edits during concurrent category rename', async () => {
    const sqlSuffix = Date.now().toString()
    const delaySequence = `test_product_category_delay_seq_${sqlSuffix}`
    const delayFunction = `test_product_category_delay_fn_${sqlSuffix}`
    const delayTrigger = `test_product_category_delay_trg_${sqlSuffix}`
    const productIds: string[] = []
    const categoryIds: string[] = []
    const documentNos: string[] = []

    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${delaySequence}"`)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${delayFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."category" LIKE '单条并发旧分类-%' THEN
          PERFORM nextval('${delaySequence}');
          PERFORM pg_sleep(0.75);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${delayTrigger}"
      BEFORE UPDATE OF "category" ON "products"
      FOR EACH ROW EXECUTE FUNCTION "${delayFunction}"()
    `)

    const sequenceValue = async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ value: bigint; is_called: boolean }>>(
        `SELECT last_value::bigint AS value, is_called FROM "${delaySequence}"`,
      )
      return row.is_called ? row.value : 0n
    }
    const waitForDelayedUpdate = async (previous: bigint) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = await sequenceValue()
        if (value > previous) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('未观察到商品分类更新进入并发延迟触发器')
    }

    try {
      for (const mode of ['plain', 'price'] as const) {
        const marker = `${mode}-${suffix.slice(-6)}`
        const sourceName = `单条并发旧分类-${marker}`
        const targetName = `单条并发新分类-${marker}`
        const category = await app.inject({
          method: 'POST', url: '/api/products/categories', payload: { name: sourceName },
        })
        expect(category.statusCode).toBe(201)
        categoryIds.push(category.json().id)

        const product = await prisma.product.create({
          data: {
            tenantId, supplierId: supplierAId, code: `SINGLE-${marker}`,
            name: `单条并发归类-${mode}`, category: '其他', price: 10,
          },
        })
        productIds.push(product.id)

        const previous = await sequenceValue()
        const patchPromise = app.inject({
          method: 'PATCH', url: `/api/products/${product.id}`,
          payload: mode === 'price'
            ? { category: sourceName, price: 12 }
            : { category: sourceName, spec: '并发分类复核' },
        })
        await waitForDelayedUpdate(previous)
        const renamePromise = app.inject({
          method: 'PATCH', url: `/api/products/categories/${category.json().id}`,
          payload: { name: targetName },
        })
        const [patched, renamed] = await Promise.all([patchPromise, renamePromise])
        expect([patched.statusCode, renamed.statusCode]).toEqual([200, 200])
        if (mode === 'price') {
          expect(patched.json()).toMatchObject({ priceChangeStatus: 'PENDING_APPROVAL' })
          documentNos.push(patched.json().documentNo)
        }
        expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({
          category: targetName,
        })
        expect(await prisma.supplierProductCategory.findUnique({
          where: { tenantId_supplierId_name: { tenantId, supplierId: supplierAId, name: sourceName } },
        })).toBeNull()
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${delayTrigger}" ON "products"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${delayFunction}"()`)
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${delaySequence}"`)
      if (documentNos.length > 0) {
        await prisma.documentDecision.deleteMany({ where: { document: { tenantId, no: { in: documentNos } } } })
        await prisma.documentStep.deleteMany({ where: { document: { tenantId, no: { in: documentNos } } } })
        await prisma.document.deleteMany({ where: { tenantId, no: { in: documentNos } } })
      }
      await prisma.opLog.deleteMany({
        where: { tenantId, targetId: { in: [...productIds, ...categoryIds] } },
      })
      await prisma.product.deleteMany({ where: { id: { in: productIds } } })
      await prisma.supplierProductCategory.deleteMany({ where: { id: { in: categoryIds } } })
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
    const unknownBatchFilter = await app.inject({
      method: 'GET', url: '/api/products/batches?unexpected=true',
    })
    expect(unknownBatchFilter.statusCode).toBe(400)
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
    const unknownReceiptFilter = await app.inject({ method: 'GET', url: '/api/receipts?dateStart=2026-07-01' })
    expect(unknownReceiptFilter.statusCode).toBe(400)
  })

  it('keeps payment and banking fields out of operational order details', async () => {
    for (const headers of [
      { 'x-test-actor': 'chef' },
      { 'x-test-actor': 'supplier-b' },
    ]) {
      for (const url of [
        `/api/orders/${orderBId}`,
        `/api/deliveries/${deliveryBId}`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers })
        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.store).toMatchObject({
          id: storeId,
          no: `S-${suffix}`,
          name: '隔离测试门店',
          address: '测试配送地址',
          phone: '13800000000',
          managerName: '测试店长',
        })
        expect(body.supplier).toMatchObject({
          id: supplierBId,
          no: `B-${suffix}`,
          name: '隔离供应商 B',
        })
        if (url.includes('/deliveries/')) {
          expect(body.receipt).toMatchObject({
            id: receiptBId,
            tempSupplierName: '供应商 B 临时名称',
          })
          expect(body.receipt).not.toHaveProperty('tempBankAccount')
          expect(body.receipt).not.toHaveProperty('tempBankName')
        }
        for (const field of [
          'aggregatorApiKeyEnc',
          'aggregatorSecretEnc',
          'wechatApiV3KeyEnc',
          'alipayPrivateKeyEnc',
          'bankAccountNo',
          'invoiceTaxId',
        ]) {
          expect(body.store).not.toHaveProperty(field)
        }
        for (const field of [
          'bankName',
          'bankAccount',
          'bankAccountName',
          'bankCode',
          'autoPay',
          'autoPayLimit',
        ]) {
          expect(body.supplier).not.toHaveProperty(field)
        }
      }
    }
  })

  it('keeps receipt bank fields and raw payment results out of operational reads', async () => {
    for (const headers of [
      { 'x-test-actor': 'chef' },
      { 'x-test-actor': 'supplier-b' },
    ]) {
      const list = await app.inject({
        method: 'GET', url: '/api/receipts?page=1&pageSize=100', headers,
      })
      expect(list.statusCode).toBe(200)
      const listedReceipt = list.json().items.find((item: any) => item.id === receiptBId)
      expect(listedReceipt).toBeDefined()
      expect(listedReceipt).toMatchObject({
        tempSupplierName: '供应商 B 临时名称',
        paymentSchedule: { status: 'PENDING', amount: '40' },
      })
      expect(listedReceipt).not.toHaveProperty('tempBankAccount')
      expect(listedReceipt).not.toHaveProperty('tempBankName')
      expect(listedReceipt.paymentSchedule).not.toHaveProperty('bankTxNo')
      expect(listedReceipt.paymentSchedule).not.toHaveProperty('bankRawResponse')
      expect(listedReceipt.paymentSchedule).not.toHaveProperty('failReason')
      expect(listedReceipt.paymentSchedule).not.toHaveProperty('retryCount')

      const detail = await app.inject({
        method: 'GET', url: `/api/receipts/${receiptBId}`, headers,
      })
      expect(detail.statusCode).toBe(200)
      const body = detail.json()
      expect(body.store).toMatchObject({ id: storeId, name: '隔离测试门店' })
      expect(body.supplier).toMatchObject({ id: supplierBId, name: '隔离供应商 B' })
      expect(body).not.toHaveProperty('tempBankAccount')
      expect(body).not.toHaveProperty('tempBankName')
      expect(body.store).not.toHaveProperty('aggregatorApiKeyEnc')
      expect(body.store).not.toHaveProperty('bankAccountNo')
      expect(body.supplier).not.toHaveProperty('bankAccount')
      expect(body.supplier).not.toHaveProperty('autoPay')
      expect(body.paymentSchedule).toEqual({
        id: expect.any(String),
        status: 'PENDING',
        dueAt: expect.any(String),
        amount: '40',
      })
    }
  })

  it('keeps payment execution internals out of supplier and store schedule lists', async () => {
    const supplierAList = await app.inject({ method: 'GET', url: '/api/schedules' })
    expect(supplierAList.statusCode).toBe(200)
    expect(supplierAList.json()).toEqual([])

    for (const headers of [
      { 'x-test-actor': 'supplier-b' },
      { 'x-test-actor': 'chef' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/schedules', headers })
      expect(response.statusCode).toBe(200)
      const schedule = response.json().find((item: any) => item.receiptId === receiptBId)
      expect(schedule).toMatchObject({
        amount: '40',
        status: 'PENDING',
        bankTxNo: 'sensitive-bank-transaction',
        failReason: 'sensitive-payment-failure',
        receipt: { id: receiptBId, no: `RK-B-${suffix}` },
        supplier: { id: supplierBId, name: '隔离供应商 B' },
      })
      for (const field of [
        'bankRawResponse',
        'retryCount',
        'paymentId',
        'notified3Days',
        'notified1Day',
        'approvedById',
        'approvedAt',
        'approvalNote',
        'rejectedAt',
        'rejectionNote',
      ]) {
        expect(schedule).not.toHaveProperty(field)
      }
    }

    const financeList = await app.inject({
      method: 'GET', url: '/api/schedules', headers: { 'x-test-actor': 'admin' },
    })
    expect(financeList.statusCode).toBe(200)
    expect(financeList.json().find((item: any) => item.receiptId === receiptBId)).toMatchObject({
      bankRawResponse: { privatePayload: 'sensitive-bank-response' },
      retryCount: 2,
    })
  })

  it('searches supplier orders by the immutable submitted product snapshot', async () => {
    const snapshotName = `原始订货名称-${suffix}`
    const snapshotCode = `ORIGINAL-${suffix}`
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-SNAPSHOT-${suffix}`, storeId, supplierId: supplierAId,
        expectedDate: new Date(), totalAmount: 10, originalTotalAmount: 10, currentOrderAmount: 10,
        status: 'SUBMITTED', createdById: chefUserId,
        submittedSnapshot: {
          items: [{ productId: productAId, name: snapshotName, code: snapshotCode, spec: '旧规格' }],
        },
        items: {
          create: {
            productId: productAId, quantity: 1, originalQuantity: 1,
            unitPrice: 10, originalUnitPrice: 10, amount: 10, originalAmount: 10,
          },
        },
      },
    })

    for (const keyword of [snapshotName, snapshotCode]) {
      const response = await app.inject({
        method: 'GET', url: `/api/orders?keyword=${encodeURIComponent(keyword)}&page=1&pageSize=20`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().items.map((item: any) => item.id)).toContain(order.id)
    }
  })

  it('rejects unknown order and delivery query fields instead of returning unfiltered data', async () => {
    for (const url of [
      '/api/orders?productName=A',
      '/api/orders?dateStart=2026-07-01',
      '/api/deliveries?productCode=A',
      '/api/deliveries?dateEnd=2026-07-31',
    ]) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(400)
    }
  })

  it('fails closed when a store-scoped role has no store binding', async () => {
    const headers = { 'x-test-actor': 'unbound-store' }
    for (const url of ['/api/orders?page=1&pageSize=100', '/api/deliveries?page=1&pageSize=100', '/api/receipts?page=1&pageSize=100']) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ total: 0, items: [] })
    }

    for (const url of [
      `/api/orders/${orderBId}`,
      `/api/orders/${orderBId}/revisions`,
      `/api/deliveries/${deliveryBId}`,
      `/api/receipts/${receiptBId}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(404)
    }

    const cancel = await app.inject({
      method: 'PATCH', url: `/api/orders/${orderBId}/cancel`, headers,
      payload: { reason: '未绑定门店账号不应能撤回订单' },
    })
    expect(cancel.statusCode).toBe(400)
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderBId } })).toMatchObject({
      status: 'CONFIRMED',
    })

    for (const url of ['/api/dashboard/stats', '/api/dashboard/purchase-trend', '/api/v2/dashboard/me']) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(403)
    }
    for (const url of ['/api/revenue', '/api/revenue/summary']) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(403)
    }
    const createRevenue = await app.inject({
      method: 'POST', url: '/api/revenue', headers,
      payload: { date: '2026-07-22', amount: 1 },
    })
    expect(createRevenue.statusCode).toBe(403)
    const paymentRequestCount = await prisma.document.count({ where: { tenantId, type: 'PAYMENT_REQUEST' } })
    const createPaymentRequest = await app.inject({
      method: 'POST', url: '/api/payment-requests', headers,
      payload: { payeeName: '未绑定门店测试收款方', amount: 1, usage: 'repair' },
    })
    expect(createPaymentRequest.statusCode).toBe(403)
    expect(await prisma.document.count({ where: { tenantId, type: 'PAYMENT_REQUEST' } })).toBe(paymentRequestCount)
    const genericDocumentCount = await prisma.document.count({ where: { tenantId, type: 'REIMBURSEMENT' } })
    const createGenericDocument = await app.inject({
      method: 'POST', url: '/api/documents', headers,
      payload: { type: 'REIMBURSEMENT', title: '未绑定门店测试报销', amount: 1, payload: {} },
    })
    expect(createGenericDocument.statusCode).toBe(403)
    expect(await prisma.document.count({ where: { tenantId, type: 'REIMBURSEMENT' } })).toBe(genericDocumentCount)

    const crossStoreDocument = await app.inject({
      method: 'POST', url: '/api/documents', headers: { 'x-test-actor': 'chef' },
      payload: {
        type: 'REIMBURSEMENT', title: '跨门店测试报销', amount: 1,
        payload: {}, storeId: 'another-store-id',
      },
    })
    expect(crossStoreDocument.statusCode).toBe(403)
    expect(await prisma.document.count({ where: { tenantId, type: 'REIMBURSEMENT' } })).toBe(genericDocumentCount)
    for (const url of ['/api/inventory', '/api/inventory/snapshot/latest', '/api/inventory/consumptions']) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(400)
    }
    const stores = await app.inject({ method: 'GET', url: '/api/stores', headers })
    expect(stores.statusCode).toBe(200)
    expect(stores.json()).toEqual([])
  })

  it('rejects malformed revenue queries and commands before writes', async () => {
    const headers = { 'x-test-actor': 'admin' }
    const beforeCount = await prisma.revenueRecord.count({ where: { store: { tenantId } } })

    for (const url of [
      '/api/revenue?month=2026-13',
      '/api/revenue/summary?month=2026-00',
      '/api/revenue?unexpected=true',
      '/api/revenue/summary?unexpected=true',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(400)
    }

    for (const payload of [
      { storeId, date: '2026-02-30', amount: 1 },
      { storeId, date: '2026-07-22', amount: 10_000_000_000 },
      { storeId, date: '2026-07-22', amount: '1.234' },
      { storeId, date: '2026-07-22', amount: 1, unexpected: true },
      { storeId, date: '2026-07-22', channels: { cash: -1 } },
      { storeId, date: '2026-07-22', channels: { cash: 'not-a-number' } },
      { storeId, date: '2026-07-22', channels: { cash: 6_000_000_000, wechat: 6_000_000_000 } },
      {
        storeId,
        date: '2026-07-22',
        channels: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`channel${index}`, 1])),
      },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/revenue', headers, payload })
      expect(response.statusCode).toBe(400)
    }

    expect(await prisma.revenueRecord.count({ where: { store: { tenantId } } })).toBe(beforeCount)
  })

  it('keeps legacy and v2 dashboards scoped for every store role', async () => {
    const marker = suffix.slice(-8)
    const otherStore = await prisma.store.create({
      data: { tenantId, no: `DASH-${marker}`, name: '看板隔离门店' },
    })
    const todayLocal = new Date()
    const revenueDate = new Date(Date.UTC(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate()))
    let otherReceiptId = ''
    let otherLossId = ''
    try {
      const [boundRevenue, otherRevenue, otherReceipt] = await prisma.$transaction([
        prisma.revenueRecord.create({
          data: { storeId, date: revenueDate, amount: 11, source: 'dashboard-scope-test' },
        }),
        prisma.revenueRecord.create({
          data: { storeId: otherStore.id, date: revenueDate, amount: 999, source: 'dashboard-scope-test' },
        }),
        prisma.receipt.create({
          data: {
            tenantId, no: `RK-DASH-${marker}`, storeId: otherStore.id, supplierId: supplierBId,
            deliveryDate: revenueDate, totalAmount: 777, status: 'ACCOUNTED', createdById: chefUserId,
            confirmedAt: new Date(), isManual: true,
          },
        }),
      ])
      expect(boundRevenue.storeId).toBe(storeId)
      expect(otherRevenue.storeId).toBe(otherStore.id)
      otherReceiptId = otherReceipt.id
      const [schedule, otherLoss] = await prisma.$transaction([
        prisma.paymentSchedule.create({
          data: {
            tenantId, receiptId: otherReceipt.id, supplierId: supplierBId, storeId: otherStore.id,
            amount: 777, creditDays: 30, confirmedAt: new Date(),
            dueAt: new Date(Date.now() + 30 * 86_400_000), status: 'PENDING_APPROVAL', needApproval: true,
          },
        }),
        prisma.lossClaim.create({
          data: {
            tenantId, no: `LC-DASH-${marker}`, kind: 'INTERNAL_WASTE', payableBasis: 'NOT_APPLICABLE', storeId: otherStore.id,
            totalLossAmount: 333, description: '看板隔离报损', evidenceImages: [],
            status: 'PENDING', isManual: true, createdById: chefUserId,
          },
        }),
      ])
      expect(schedule.storeId).toBe(otherStore.id)
      otherLossId = otherLoss.id

      const stats = await app.inject({
        method: 'GET', url: '/api/dashboard/stats', headers: { 'x-test-actor': 'chef' },
      })
      expect(stats.statusCode).toBe(200)
      expect(stats.json()).toMatchObject({ pendingApprovalCount: 0, pendingLossCount: 1, storeBreakdown: [] })
      expect(stats.json().recentReceipts.some((receipt: any) => receipt.id === otherReceipt.id)).toBe(false)

      const trend = await app.inject({
        method: 'GET', url: '/api/dashboard/purchase-trend', headers: { 'x-test-actor': 'chef' },
      })
      expect(trend.statusCode).toBe(200)
      expect(trend.json().reduce((sum: number, row: any) => sum + Number(row.amount), 0)).toBe(40)

      const purchaserDashboard = await app.inject({
        method: 'GET', url: '/api/v2/dashboard/me', headers: { 'x-test-actor': 'purchaser' },
      })
      expect(purchaserDashboard.statusCode).toBe(200)
      expect(purchaserDashboard.json().hero).toMatchObject({
        value: '¥11', stats: [{ label: '月营收', value: '¥11' }],
      })

      const purchaserRevenue = await app.inject({
        method: 'GET', url: '/api/revenue', headers: { 'x-test-actor': 'purchaser' },
      })
      expect(purchaserRevenue.statusCode).toBe(200)
      expect(purchaserRevenue.json().map((record: any) => record.storeId)).toEqual([storeId])
      const purchaserSummary = await app.inject({
        method: 'GET', url: '/api/revenue/summary', headers: { 'x-test-actor': 'purchaser' },
      })
      expect(purchaserSummary.statusCode).toBe(200)
      expect(purchaserSummary.json()).toMatchObject({
        total: 11, stores: [{ storeId, total: 11, days: 1 }],
      })
    } finally {
      if (otherReceiptId) await prisma.paymentSchedule.deleteMany({ where: { receiptId: otherReceiptId } })
      if (otherLossId) await prisma.lossClaim.deleteMany({ where: { id: otherLossId } })
      if (otherReceiptId) await prisma.receipt.deleteMany({ where: { id: otherReceiptId } })
      await prisma.revenueRecord.deleteMany({ where: { storeId: { in: [storeId, otherStore.id] }, source: 'dashboard-scope-test' } })
      await prisma.store.delete({ where: { id: otherStore.id } })
    }
  })

  it('cannot list supplier B arrival claims', async () => {
    const claims = await app.inject({ method: 'GET', url: '/api/loss-claims?page=1&pageSize=100' })
    expect(claims.statusCode).toBe(200)
    expect(claims.json()).toMatchObject({ total: 0, items: [] })
    const limitedClaims = await app.inject({ method: 'GET', url: '/api/loss-claims?limit=10' })
    expect(limitedClaims.statusCode).toBe(200)
    expect(limitedClaims.json()).toEqual([])
    for (const url of [
      '/api/loss-claims?limit=0',
      '/api/loss-claims?limit=101',
      '/api/loss-claims?page=0',
      '/api/loss-claims?pageSize=101',
      '/api/loss-claims?limit=10&page=1',
      '/api/loss-claims/export?limit=10',
    ]) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(400)
    }
  })

  it('rejects manual loss amounts beyond database bounds before writes', async () => {
    const highCostProduct = await prisma.product.create({
      data: {
        tenantId, supplierId: supplierAId, code: `LOSS-BOUND-${suffix}`,
        name: '店内报损金额边界商品', unit: '件', price: 20_000, stock: 0,
      },
    })
    const snapshot = await prisma.inventorySnapshot.create({
      data: {
        tenantId, storeId, snapshotDate: new Date('2026-07-18T00:00:00.000Z'),
        sourceFilename: 'manual-loss-amount-boundary.xlsx', sourceHash: `loss-bound-${suffix}`,
        totalValue: 20_000, itemCount: 1, nonzeroCount: 1, zeroCount: 0, matchedCount: 1,
        items: {
          create: {
            productId: highCostProduct.id, section: '测试', rawName: highCostProduct.name,
            unit: '件', quantity: 1, unitPrice: 20_000, amount: 20_000, sortOrder: 1,
          },
        },
      },
    })
    try {
      const beforeCount = await prisma.lossClaim.count({ where: { tenantId, isManual: true } })
      const response = await app.inject({
        method: 'POST', url: '/api/loss-claims/manual', headers: { 'x-test-actor': 'chef' },
        payload: {
          items: [{ productId: highCostProduct.id, quantity: 1_000_000 }],
          reason: '金额边界验证',
        },
      })
      expect(response.statusCode).toBe(400)
      expect(await prisma.lossClaim.count({ where: { tenantId, isManual: true } })).toBe(beforeCount)
    } finally {
      await prisma.inventorySnapshot.delete({ where: { id: snapshot.id } })
      await prisma.product.delete({ where: { id: highCostProduct.id } })
    }
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

  it('rejects unknown and empty store inventory query fields', async () => {
    const headers = { 'x-test-actor': 'chef' }
    for (const url of [
      '/api/inventory?unexpected=true',
      '/api/inventory/snapshot/latest?unexpected=true',
      '/api/inventory/consumptions?days=30&unexpected=true',
      '/api/inventory?storeId=',
      '/api/inventory/snapshot/latest?storeId=',
      '/api/inventory/consumptions?storeId=',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(400)
    }
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
