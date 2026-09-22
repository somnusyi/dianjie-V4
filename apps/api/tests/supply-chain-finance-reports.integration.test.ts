import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { randomUUID } from 'crypto'
import { supplyChainFinanceReportRoutes } from '../src/routes/supplyChainFinanceReports'

const app = Fastify()
let tenantId = '', otherTenantId = '', warehouseId = '', productId = '', deliveryId = '', itemId = ''
let token = '', financeToken = '', supplierToken = '', otherToken = '', managerToken = ''
const headers = (t = token) => ({ authorization: `Bearer ${t}` })
const report = (id: string, extra = '', t = token) => app.inject({ url: `/api/supply-chain/finance-reports/${id}?start=2026-09-01&end=2026-09-21${extra}`, headers: headers(t) })
const move = (data: any) => prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type: 'ORDER_OUTBOUND', sourceType: 'DeliveryOrder', sourceId: deliveryId, sourceLineId: itemId, physicalDelta: -20, valueDelta: -100, physicalAfter: 0, reservedAfter: 0, valueAfter: 0, averageUnitCostAfter: 5, originalQuantity: 2, originalUnit: '箱', conversionFactor: 10, inventoryQuantity: 20, inventoryUnit: 'kg', inventoryUnitCost: 5, effectiveAt: new Date('2026-09-01T00:00:00Z'), idempotencyKey: randomUUID(), ...data } })

describe('supply-chain financial reports against PostgreSQL', () => {
  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { slug: `finance-${randomUUID()}`, name: '财务集成测试' } })).id
    otherTenantId = (await prisma.tenant.create({ data: { slug: `finance-other-${randomUUID()}`, name: '其他租户' } })).id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: 'HQ', name: '总部', sourceType: 'HEADQ_WAREHOUSE' } })
    const user = await prisma.user.create({ data: { tenantId, email: 'finance@local.test', name: '测试', password: 'unused', role: 'SUPPLY_CHAIN' } })
    const store = await prisma.store.create({ data: { tenantId, no: 'C01', name: '客户一' } })
    productId = (await prisma.product.create({ data: { tenantId, supplierId: supplier.id, code: 'P01', name: '现名称', price: 999, unit: '箱', status: 'ENABLED' } })).id
    const order = await prisma.purchaseOrder.create({ data: { tenantId, no: 'PO-FIN', supplierId: supplier.id, storeId: store.id, expectedDate: new Date('2026-09-01'), totalAmount: 200, createdById: user.id } })
    itemId = (await prisma.purchaseOrderItem.create({ data: { purchaseOrderId: order.id, productId, quantity: 2, unitPrice: 100, amount: 200 } })).id
    const delivery = await prisma.deliveryOrder.create({ data: { tenantId, warehouseId, no: 'DO-FIN', supplierId: supplier.id, storeId: store.id, purchaseOrderId: order.id, createdById: user.id, status: 'CANCELLED', shippedAt: new Date('2026-09-01T00:00:00Z'), items: { create: { purchaseOrderItemId: itemId, productId, orderedQtySnapshot: 2, shippedQty: 1.5, amount: 150, unitPriceSnapshot: 100, productNameSnapshot: '历史名称', productCodeSnapshot: 'P01', productSpecSnapshot: '10kg/箱', productCategorySnapshot: '蔬菜', inventoryUnitSnapshot: 'kg', inventoryUnitsPerOrderUnitSnapshot: 10 } } } }); deliveryId = delivery.id
    const original = await move({ effectiveAt: new Date('2026-08-31T16:00:00Z') })
    await move({ type: 'REVERSAL', sourceType: 'ReceiptRejectionReversal', sourceId: 'receipt', sourceLineId: original.id, physicalDelta: 5, valueDelta: 25, originalQuantity: 0.5, inventoryQuantity: 5, effectiveAt: new Date('2026-09-21T15:59:59Z') })
    await move({ effectiveAt: new Date('2026-09-21T16:00:00Z') }) // next business day, excluded
    // An ordinary purchase/manual inbound is not a sales return.
    await move({ type: 'MANUAL_INBOUND', sourceType: 'WarehouseManualInbound', sourceId: 'inbound', physicalDelta: 100, valueDelta: 500 })
    const historic = await move({ effectiveAt: new Date('2026-08-30T00:00:00Z') })
    await move({ type: 'REVERSAL', sourceType: 'DeliveryOrderShipCancel', sourceId: 'cancel', sourceLineId: historic.id, physicalDelta: 2, valueDelta: 10, originalQuantity: 0.2, inventoryQuantity: 2 })
    await app.register(jwt, { secret: 'finance-report-integration-only' })
    app.decorate('authenticate', async (req: any) => req.jwtVerify())
    await app.register(supplyChainFinanceReportRoutes, { prefix: '/api/supply-chain/finance-reports' }); await app.ready()
    token = app.jwt.sign({ tenantId, userId: user.id, role: 'SUPPLY_CHAIN' })
    financeToken = app.jwt.sign({ tenantId, userId: user.id, role: 'FINANCE' })
    supplierToken = app.jwt.sign({ tenantId, role: 'SUPPLIER_OWNER' }); managerToken = app.jwt.sign({ tenantId, role: 'MANAGER' }); otherToken = app.jwt.sign({ tenantId: otherTenantId, role: 'ADMIN' })
  })
  afterAll(async () => {
    await app.close()
    if (!tenantId) return
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } }); await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } }); await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.store.deleteMany({ where: { tenantId: tenants } }); await prisma.warehouse.deleteMany({ where: { tenantId: tenants } }); await prisma.tenant.deleteMany({ where: { id: tenants } })
  })
  it('enforces authentication, tenant isolation and finance/supply-chain permissions', async () => {
    expect((await app.inject('/api/supply-chain/finance-reports/group-profit')).statusCode).toBe(401)
    for (const id of ['group-profit', 'item-profit', 'profit-detail']) {
      expect((await report(id, '', financeToken)).statusCode).toBe(200)
      expect((await report(id, '', supplierToken)).statusCode).toBe(403)
      expect((await report(id, '&export=1', managerToken)).statusCode).toBe(403)
      expect((await report(id, '', otherToken)).json()).toMatchObject({ total: 0, options: { customer: [] } })
    }
  })
  it('uses frozen prices and ledger costs, reverses historical shipments in Shanghai business dates', async () => {
    const res = await report('profit-detail'); expect(res.statusCode, res.body).toBe(200)
    const rows = res.json().rows
    expect(rows).toHaveLength(3)
    expect(rows.find((r: any) => r.source === '配送出库')).toMatchObject({ name: '客户一', code: 'C01', quantity: 20, cost: 100, revenue: 200, date: '2026-09-01' })
    expect(rows.find((r: any) => r.source === '返货入库')).toMatchObject({ quantity: -5, cost: -25, revenue: -50, date: '2026-09-21' })
    expect(rows.find((r: any) => r.source === '配送撤销/减量')).toMatchObject({ quantity: -2, revenue: -20, cost: -10 })
    expect((await report('group-profit')).json().rows[0]).toMatchObject({ revenue: 130, cost: 65, profit: 65 })
    expect((await report('item-profit')).json().rows[0]).toMatchObject({ itemName: '历史名称', quantity: 13, revenue: 130, cost: 65, rate: 0.5, averageRevenue: 10, averageCost: 5 })
  })
  it('filters before grouping; numeric filters apply after aggregation; stable pagination and full Excel export', async () => {
    expect((await report('profit-detail', `&source=${encodeURIComponent('返货入库')}`)).json().total).toBe(1)
    expect((await report('group-profit', `&ranges=${encodeURIComponent(JSON.stringify({ revenue: { max: 140 } }))}`)).json().total).toBe(1)
    expect((await report('profit-detail', '&keyword=nonexistent')).json().total).toBe(0)
    expect((await report('profit-detail', `&customer=${encodeURIComponent('客户一')}&document=DO-FIN`)).json().total).toBe(3)
    const page = (await report('profit-detail', '&pageSize=1&page=2&sort=revenue&direction=desc')).json()
    expect(page.rows).toHaveLength(1); expect(page.rows[0].revenue).toBe(-20)
    for (const id of ['group-profit', 'item-profit', 'profit-detail']) {
      const list = (await report(id)).json()
      const exported = await report(id, '&pageSize=1&export=1'); expect(exported.statusCode).toBe(200)
      const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(exported.json().fileBase64, 'base64') as any)
      expect(book.worksheets[0].rowCount).toBe(list.total + 1)
      for (const [i, row] of list.rows.entries()) for (const [j, column] of list.columns.entries()) expect(book.worksheets[0].getRow(i + 2).getCell(j + 1).value ?? null).toEqual(row[column.key] ?? null)
    }
  })
  it('rejects invalid dates, ranges, pages and report names', async () => {
    expect((await report('unknown')).statusCode).toBe(400)
    for (const extra of ['&ranges=wrong', '&page=0', '&pageSize=1000', '&start=2026-02-30', '&start=2026-10-01', `&ranges=${encodeURIComponent('{"revenue":{"min":2,"max":1}}')}`]) expect((await report('group-profit', extra)).statusCode).toBe(400)
  })
  it('does not substitute current product prices or zero cost for unposted history', async () => {
    const d = await prisma.deliveryOrder.findUniqueOrThrow({ where: { id: deliveryId } })
    await prisma.deliveryOrder.create({ data: { tenantId, warehouseId, no: 'DO-UNPOSTED', supplierId: d.supplierId, storeId: d.storeId, purchaseOrderId: d.purchaseOrderId, createdById: d.createdById, status: 'SHIPPED', shippedAt: d.shippedAt, items: { create: { productId, orderedQtySnapshot: 1, shippedQty: 1, amount: 50, unitPriceSnapshot: 50, productCodeSnapshot: 'P01', inventoryUnitSnapshot: 'kg', inventoryUnitsPerOrderUnitSnapshot: 10 } } } })
    const res = (await report('group-profit')).json()
    expect(res.warnings).not.toHaveLength(0)
    expect(res.rows[0]).toMatchObject({ revenue: 180, cost: null, profit: null })
    expect((await report('item-profit')).json().rows.find((r: any) => r.cost == null)).toMatchObject({ rate: null, averageCost: null })
  })
})
