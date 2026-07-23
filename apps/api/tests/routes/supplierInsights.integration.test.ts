import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { supplierInsightRoutes } from '../../src/routes/supplierInsights'

const suffix = `supplier-insights-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let userId = ''
let app: ReturnType<typeof Fastify>

describe('supplier insights receipt facts (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `洞察测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '洞察测试供应商' } })
    supplierId = supplier.id
    const store = await prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '洞察测试门店' } })
    storeId = store.id
    const user = await prisma.user.create({
      data: {
        tenantId, supplierId, name: '洞察测试账号', email: `${suffix}@local.test`,
        password: 'integration-test-only', role: 'SUPPLIER_OWNER',
      },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: { tenantId, supplierId, code: `${suffix}-P`, name: '历史鲜菌', unit: '斤', price: 10, stock: 20 },
    })
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId: product.id, batchNo: `OPENING-${suffix}`,
        kind: 'OPENING', initialQty: 20, remainingQty: 20, createdById: userId,
      },
    })
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-${suffix}`, storeId, supplierId,
        expectedDate: new Date(), totalAmount: 100, status: 'COMPLETED', createdById: userId,
      },
    })
    await prisma.receipt.create({
      data: {
        tenantId, no: `RK-${suffix}`, storeId, supplierId, purchaseOrderId: order.id,
        deliveryDate: new Date(), totalAmount: 60, status: 'CONFIRMED', confirmedAt: new Date(), createdById: userId,
        items: {
          create: {
            productId: product.id, quantity: 6, unitPrice: 10, amount: 60,
            productNameSnapshot: '入库时鲜菌', productUnitSnapshot: '斤',
          },
        },
      },
    })
    await prisma.product.update({ where: { id: product.id }, data: { name: '后来改名', unit: '箱' } })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, supplierId, userId, role: 'SUPPLIER_OWNER' }
    })
    await app.register(supplierInsightRoutes, { prefix: '/api/supplier/insights' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } })
    await prisma.receipt.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('uses receipt payable amount instead of purchase order amount', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/customers?days=90' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject([{
      storeId,
      totalOrders: 1,
      totalAmount: 60,
      amountBasis: 'RECEIPT_PAYABLE',
    }])
  })

  it('ranks the frozen receipt item name and actual received quantity', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=30&limit=10' })
    expect(response.statusCode).toBe(200)
    expect(response.json().top[0]).toMatchObject({ name: '入库时鲜菌', unit: '斤', qty: 6, amount: 60 })
  })

  it('builds monthly trend from confirmed receipts', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sales-trend?months=3' })
    expect(response.statusCode).toBe(200)
    const current = response.json().find((row: any) => row.month === new Date().toISOString().slice(0, 7))
    expect(current).toMatchObject({ revenue: 60, receivedAmount: 60, orders: 1, amountBasis: 'RECEIPT_PAYABLE' })
  })

  it('rejects malformed, out-of-range and unknown insight query fields', async () => {
    for (const url of [
      '/api/supplier/insights/customers?days=90days',
      '/api/supplier/insights/audit?days=6',
      '/api/supplier/insights/sku-rank?days=366',
      '/api/supplier/insights/sku-rank?limit=51',
      '/api/supplier/insights/sales-trend?months=2',
      '/api/supplier/insights/sales-trend?unexpected=true',
    ]) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(400)
    }

    expect((await app.inject({ method: 'GET', url: '/api/supplier/insights/customers?days=7' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=365&limit=50' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/supplier/insights/sales-trend?months=12' })).statusCode).toBe(200)
  })

  it('reports missing payable without inventing an amount error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/audit?days=90' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.summary.errors).toBe(0)
    expect(body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PAYABLE_MISSING', severity: 'WARNING' }),
    ]))
  })

  it('detects a broken stock ledger balance', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { tenantId, supplierId } })
    const movement = await prisma.supplierStockMovement.create({
      data: {
        tenantId, supplierId, productId: product.id, delta: 5, balanceAfter: 999,
        type: 'INBOUND_MANUAL', reason: '故意构造的审计异常', createdById: userId,
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/audit?days=90' })
    expect(response.statusCode).toBe(200)
    expect(response.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STOCK_LEDGER_BALANCE_MISMATCH', severity: 'ERROR', entityId: product.id }),
    ]))
    await prisma.supplierStockMovement.delete({ where: { id: movement.id } })
  })
})
