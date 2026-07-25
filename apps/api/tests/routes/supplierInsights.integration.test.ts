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
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '洞察测试供应商', inventoryMode: 'STRICT' } })
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
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
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

  it('returns orderUnitPrice with g-to-斤 conversion for bottom SKUs', async () => {
    const converted = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-CONV`, name: '鲜菌克',
        unit: '斤', price: 0.02, stock: 100,
        purchaseUnit: '箱', inventoryUnit: 'g', orderUnit: '斤', costUnit: 'g',
        inventoryUnitsPerPurchaseUnit: 10000, inventoryUnitsPerOrderUnit: 500,
        inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED',
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=30&limit=10' })
    expect(response.statusCode).toBe(200)
    const bottom = response.json().bottom as any[]
    const hit = bottom.find(item => item.productId === converted.id)
    expect(hit).toBeTruthy()
    expect(hit.orderUnitPrice).toBe(10)
    expect(hit.valuationStatus).toBe('VALUED')
    expect(hit.orderUnit).toBe('斤')
    expect(hit.costUnit).toBe('g')
    expect(hit).not.toHaveProperty('price')
    await prisma.product.delete({ where: { id: converted.id } })
  })

  it('returns PENDING valuation for bottom SKUs with unverified four units', async () => {
    const pending = await prisma.product.create({
      data: {
        tenantId, supplierId, code: `${suffix}-PEND`, name: '待核验菌',
        unit: '斤', price: 0.02, stock: 50,
        purchaseUnit: '箱', inventoryUnit: 'g', orderUnit: '斤', costUnit: 'g',
        inventoryUnitsPerPurchaseUnit: 10000, inventoryUnitsPerOrderUnit: 500,
        inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'PENDING',
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=30&limit=10' })
    expect(response.statusCode).toBe(200)
    const bottom = response.json().bottom as any[]
    const hit = bottom.find(item => item.productId === pending.id)
    expect(hit).toBeTruthy()
    expect(hit.orderUnitPrice).toBeNull()
    expect(hit.valuationStatus).toBe('PENDING')
    await prisma.product.delete({ where: { id: pending.id } })
  })

  it('does not leak bottom SKUs from another tenant or supplier', async () => {
    const otherTenant = await prisma.tenant.create({ data: { name: `隔离租户-${suffix}`, slug: `iso-${suffix}` } })
    const otherSupplier = await prisma.supplier.create({
      data: { tenantId: otherTenant.id, no: `SUP-ISO-${suffix}`, name: '隔离供应商', inventoryMode: 'STRICT' },
    })
    const otherProduct = await prisma.product.create({
      data: {
        tenantId: otherTenant.id, supplierId: otherSupplier.id,
        code: `${suffix}-ISO`, name: '隔离商品', unit: '斤', price: 5, stock: 10,
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=30&limit=50' })
    expect(response.statusCode).toBe(200)
    const allProductIds = [
      ...response.json().top.map((item: any) => item.productId),
      ...response.json().bottom.map((item: any) => item.productId),
    ]
    expect(allProductIds).not.toContain(otherProduct.id)
    await prisma.product.delete({ where: { id: otherProduct.id } })
    await prisma.supplier.delete({ where: { id: otherSupplier.id } })
    await prisma.tenant.delete({ where: { id: otherTenant.id } })
  })

  it('keeps top SKU amounts from receipt history regardless of current product price', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/supplier/insights/sku-rank?days=30&limit=10' })
    expect(response.statusCode).toBe(200)
    const top = response.json().top as any[]
    expect(top.length).toBeGreaterThan(0)
    const first = top[0]
    expect(first.name).toBe('入库时鲜菌')
    expect(first.qty).toBe(6)
    expect(first.amount).toBe(60)
    expect(first).not.toHaveProperty('orderUnitPrice')
    expect(first).not.toHaveProperty('valuationStatus')
  })
})
