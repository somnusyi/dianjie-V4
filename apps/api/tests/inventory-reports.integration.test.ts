import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { randomUUID } from 'crypto'
import { inventoryReportRoutes } from '../src/routes/inventoryReports'
import { reportIds } from '../src/services/inventoryReports'
import fieldContract from '../src/services/report-field-contract.json'
import { storeTransferRoutes } from '../src/routes/storeTransfers'

const app = Fastify()
let tenantId = '', otherTenantId = '', supplierId = '', productId = '', secondProductId = '', warehouseId = '', secondWarehouseId = '', fromStoreId = '', toStoreId = '', foreignStoreId = '', userId = ''
let token = '', adminToken = '', supplierToken = '', foreignToken = '', financeToken = '', purchaserToken = ''
const headers = (value = token) => ({ authorization: `Bearer ${value}` })
const query = 'start=2026-09-01&end=2026-09-21'
const report = (id: string, extra = '', t = token) => app.inject({ url: `/api/inventory-reports/${id}?${query}${extra}`, headers: headers(t) })
const savePolicy = (payload: Record<string, unknown>, id = productId, t = token) => app.inject({ method: 'PATCH', url: `/api/inventory-reports/policies/${id}`, headers: headers(t), payload })
const listPolicies = (extra = '', t = token) => app.inject({ url: `/api/inventory-reports/policies${extra}`, headers: headers(t) })
const create = (overrides: any = {}) => app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(adminToken), payload: { fromStoreId, toStoreId, transferDate: '2026-09-21', requestKey: randomUUID(), items: [{ productId, quantity: 3, cost: 2, settlement: 2.5 }], ...overrides } })
const transition = (id: string, status: string) => app.inject({ method: 'PATCH', url: `/api/store-transfers/${id}/status`, headers: headers(adminToken), payload: { status } })

describe('inventory reports and persistent store transfers', () => {
  beforeAll(async () => {
    const suffix = randomUUID()
    const tenant = await prisma.tenant.create({ data: { name: '报表测试', slug: `reports-${suffix}` } }); tenantId = tenant.id
    const other = await prisma.tenant.create({ data: { name: '隔离租户', slug: `other-${suffix}` } }); otherTenantId = other.id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    secondWarehouseId = (await prisma.warehouse.create({ data: { tenantId, code: `SECOND-${suffix}`, name: '二号仓', isDefault: false, isActive: true } })).id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: 'SUP', name: '测试供应商' } }); supplierId = supplier.id
    const product = await prisma.product.create({ data: { tenantId, supplierId: supplier.id, code: 'REPORT-01', name: '测试土豆', price: 3, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', status: 'ENABLED' } }); productId = product.id
    const secondProduct = await prisma.product.create({ data: { tenantId, supplierId: supplier.id, code: 'REPORT-02', name: '测试红薯', price: 4, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', status: 'ENABLED' } }); secondProductId = secondProduct.id
    userId = (await prisma.user.create({ data: { tenantId, email: 'report@local.test', name: '测试', password: 'test-only', role: 'SUPPLY_CHAIN' } })).id
    fromStoreId = (await prisma.store.create({ data: { tenantId, no: 'A', name: '调出门店' } })).id
    toStoreId = (await prisma.store.create({ data: { tenantId, no: 'B', name: '调入门店' } })).id
    foreignStoreId = (await prisma.store.create({ data: { tenantId: otherTenantId, no: 'C', name: '其他租户门店' } })).id
    const deliveryPurchaseOrder = await prisma.purchaseOrder.create({ data: {
      tenantId, no: `PO-PROFIT-${suffix}`, storeId: fromStoreId, supplierId, expectedDate: new Date('2026-09-20T00:00:00Z'),
      totalAmount: 20, originalTotalAmount: 20, currentOrderAmount: 20, createdById: userId,
    } })
    const deliveryPurchaseItem = await prisma.purchaseOrderItem.create({ data: {
      purchaseOrderId: deliveryPurchaseOrder.id, productId: secondProductId, quantity: 4, originalQuantity: 4,
      shippedQty: 4, unitPrice: 5, originalUnitPrice: 5, amount: 20, originalAmount: 20,
      orderUnitSnapshot: 'kg', inventoryUnitSnapshot: 'kg', purchaseUnitSnapshot: '箱', costUnitSnapshot: 'kg',
      inventoryUnitsPerOrderUnitSnapshot: 1, inventoryUnitsPerPurchaseUnitSnapshot: 10, inventoryUnitsPerCostUnitSnapshot: 1,
      unitConversionStatusSnapshot: 'VERIFIED',
    } })
    const delivery = await prisma.deliveryOrder.create({ data: {
      tenantId, no: `DO-PROFIT-${suffix}`, purchaseOrderId: deliveryPurchaseOrder.id, storeId: fromStoreId,
      supplierId, warehouseId, status: 'SHIPPED', actualTotalAmount: 20, createdById: userId, shippedById: userId,
      shippedAt: new Date('2026-09-20T02:00:00Z'),
    } })
    await prisma.deliveryOrderItem.create({ data: {
      deliveryOrderId: delivery.id, purchaseOrderItemId: deliveryPurchaseItem.id, productId: secondProductId,
      orderedQtySnapshot: 4, shippedQty: 3.75, unitPriceSnapshot: 5, amount: 18.75,
      productCodeSnapshot: 'REPORT-02', productNameSnapshot: '测试红薯', productUnitSnapshot: 'kg',
      orderUnitSnapshot: 'kg', inventoryUnitSnapshot: 'kg', purchaseUnitSnapshot: '箱', costUnitSnapshot: 'kg',
      inventoryUnitsPerOrderUnitSnapshot: 1, inventoryUnitsPerPurchaseUnitSnapshot: 10, inventoryUnitsPerCostUnitSnapshot: 1,
      unitConversionStatusSnapshot: 'VERIFIED',
    } })
    const firstDeliveryMovement = await prisma.warehouseLedgerMovement.create({ data: {
      tenantId, warehouseId, productId: secondProductId, type: 'ORDER_OUTBOUND', effectiveAt: new Date('2026-09-20T02:00:00Z'),
      physicalDelta: -2, valueDelta: -6, physicalAfter: 2, reservedAfter: 0, valueAfter: 6, averageUnitCostAfter: 3,
      originalQuantity: 2, originalUnit: 'kg', conversionFactor: 1, inventoryQuantity: 2, inventoryUnit: 'kg', inventoryUnitCost: 3,
      sourceType: 'DeliveryOrder', sourceId: delivery.id, sourceLineId: deliveryPurchaseItem.id, idempotencyKey: `profit-a-${suffix}`,
    } })
    const secondDeliveryMovement = await prisma.warehouseLedgerMovement.create({ data: {
      tenantId, warehouseId: secondWarehouseId, productId: secondProductId, type: 'ORDER_OUTBOUND', effectiveAt: new Date('2026-09-20T02:01:00Z'),
      physicalDelta: -2, valueDelta: -6, physicalAfter: 0, reservedAfter: 0, valueAfter: 0, averageUnitCostAfter: 3,
      originalQuantity: 2, originalUnit: 'kg', conversionFactor: 1, inventoryQuantity: 2, inventoryUnit: 'kg', inventoryUnitCost: 3,
      sourceType: 'DeliveryOrder', sourceId: delivery.id, sourceLineId: deliveryPurchaseItem.id, idempotencyKey: `profit-b-${suffix}`,
    } })
    for (const [index, sourceType, sourceLineId, sourceWarehouseId, effectiveAt] of [
      [0, 'DeliveryOrderShipCancel', firstDeliveryMovement.id, warehouseId, '2026-09-20T02:10:00Z'],
      [1, 'ReceiptRejectionReversal', firstDeliveryMovement.id, warehouseId, '2026-09-20T02:11:00Z'],
      [2, 'LossClaimReversal', secondDeliveryMovement.id, secondWarehouseId, '2026-10-01T02:12:00Z'],
    ] as const) {
      await prisma.warehouseLedgerMovement.create({ data: {
        tenantId, warehouseId: sourceWarehouseId, productId: secondProductId, type: 'REVERSAL', effectiveAt: new Date(effectiveAt),
        physicalDelta: 0.25, valueDelta: 0.75, physicalAfter: 0.25 * (index + 1), reservedAfter: 0, valueAfter: 0.75 * (index + 1), averageUnitCostAfter: 3,
        originalQuantity: 0.25, originalUnit: 'kg', conversionFactor: 1, inventoryQuantity: 0.25, inventoryUnit: 'kg', inventoryUnitCost: 3,
        sourceType, sourceId: `${sourceType}-${suffix}`, sourceLineId, idempotencyKey: `profit-reversal-${index}-${suffix}`,
      } })
    }
    await prisma.warehouseLedgerMovement.create({ data: {
      tenantId, warehouseId, productId, type: 'REVERSAL', effectiveAt: new Date('2026-10-02T02:12:00Z'),
      physicalDelta: 0.25, valueDelta: 0.75, physicalAfter: 0.25, reservedAfter: 0, valueAfter: 0.75, averageUnitCostAfter: 3,
      originalQuantity: 0.25, originalUnit: 'kg', conversionFactor: 1, inventoryQuantity: 0.25, inventoryUnit: 'kg', inventoryUnitCost: 3,
      sourceType: 'ReceiptRejectionReversal', sourceId: `wrong-product-${suffix}`, sourceLineId: firstDeliveryMovement.id, idempotencyKey: `profit-wrong-product-${suffix}`,
    } })
    for (const [date, qty, value, type] of [['2026-08-31T15:59:59Z', 10, 20, 'OPENING_BALANCE'], ['2026-08-31T16:00:00Z', 5, 15, 'MANUAL_INBOUND'], ['2026-09-21T15:59:59Z', -2, -4, 'ORDER_OUTBOUND'], ['2026-09-21T16:00:00Z', 99, 198, 'MANUAL_INBOUND']] as const) {
      await prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type, effectiveAt: new Date(date), physicalDelta: qty, valueDelta: value, physicalAfter: 0, reservedAfter: 0, valueAfter: 0, averageUnitCostAfter: 0, originalQuantity: qty === 5 ? 0.5 : Math.abs(qty), originalUnit: qty === 5 ? '箱' : 'kg', conversionFactor: qty === 5 ? 10 : 1, inventoryQuantity: Math.abs(qty), inventoryUnit: 'kg', sourceType: qty === 5 ? 'WarehouseManualInbound' : 'ReportFixture', sourceId: randomUUID(), idempotencyKey: randomUUID() } })
    }
    await prisma.warehouseLedgerBalance.create({ data: { tenantId, warehouseId, productId, inventoryUnit: 'kg', physicalQty: 112, reservedQty: 2, inventoryValue: 229, averageUnitCost: 2.044643 } })
    await app.register(jwt, { secret: 'inventory-report-integration-secret-only' })
    app.decorate('authenticate', async (req: any) => { await req.jwtVerify() })
    await app.register(inventoryReportRoutes, { prefix: '/api/inventory-reports' }); await app.register(storeTransferRoutes, { prefix: '/api/store-transfers' })
    token = app.jwt.sign({ userId, tenantId, role: 'SUPPLY_CHAIN' }); adminToken = app.jwt.sign({ userId, tenantId, role: 'ADMIN' }); supplierToken = app.jwt.sign({ userId, tenantId, role: 'SUPPLIER_OWNER' }); foreignToken = app.jwt.sign({ userId, tenantId: otherTenantId, role: 'ADMIN' }); financeToken = app.jwt.sign({ userId, tenantId, role: 'FINANCE' }); purchaserToken = app.jwt.sign({ userId, tenantId, role: 'PURCHASER', storeId: fromStoreId, storeIds: [fromStoreId] })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    if (!tenantId) return
    await prisma.storeTransferItem.deleteMany({ where: { transfer: { tenantId } } }); await prisma.storeTransfer.deleteMany({ where: { tenantId } })
    await prisma.warehouseInventoryPolicyEvent.deleteMany({ where: { tenantId } }); await prisma.warehouseInventoryPolicy.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } }); await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } }); await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }); await prisma.warehouse.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }); await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
  })
  it('enforces authentication, role and tenant boundaries', async () => {
    expect((await app.inject('/api/inventory-reports/realtime')).statusCode).toBe(401)
    expect((await report('realtime', '', supplierToken)).statusCode).toBe(403)
    expect((await report('realtime', '', financeToken)).statusCode).toBe(200)
    expect((await report('realtime', '', foreignToken)).json().total).toBe(0)
    expect((await report('realtime', `&warehouseId=${warehouseId}`, foreignToken)).json().total).toBe(0)
    expect((await app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(), payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/api/store-transfers/not-visible/status', headers: headers(), payload: { status: 'SHIPPED' } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/store-transfers', headers: headers() })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/store-transfers/products', headers: headers() })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(financeToken), payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/store-transfers', headers: headers(financeToken) })).statusCode).toBe(200)
    for (const id of reportIds) expect((await report(id, '', purchaserToken)).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/store-transfers', headers: headers(purchaserToken) })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/store-transfers/products', headers: headers(purchaserToken) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(purchaserToken), payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: '/api/store-transfers/not-visible/status', headers: headers(purchaserToken), payload: { status: 'SHIPPED' } })).statusCode).toBe(403)
  })
  it('reconciles Shanghai date boundaries and preserves complete balances with type filters', async () => {
    const response = await report('summary'); expect(response.statusCode).toBe(200)
    const row = response.json().rows[0]; expect(row).toMatchObject({ openingQty: 10, openingAmount: 20, inQty: 5, inAmount: 15, outQty: 2, outAmount: 4, closingQty: 13, closingAmount: 31 })
    expect((await report('summary', `&type=${encodeURIComponent('出库')}`)).json().rows[0]).toMatchObject({ openingQty: 10, closingQty: 13 })
  })
  it('does not mislabel unknown tax values, validates dates and numeric ranges', async () => {
    const rows = (await report('movements')).json().rows; expect(rows).toHaveLength(6)
    expect(rows.find((r: any) => r.inBaseQty === 5).inAmount).toBeNull()
    const deliveryRows = rows.filter((r: any) => r.code === 'REPORT-02')
    expect(deliveryRows).toHaveLength(4)
    expect(deliveryRows.filter((r: any) => r.type === '出库')).toHaveLength(2)
    expect(deliveryRows.filter((r: any) => r.type === '出库')[0]).toMatchObject({ outQty: 2, outPrice: 3, outAmount: 6, outSettlementPrice: 5, outSettlementAmount: 10, outProfit: 4 })
    expect(deliveryRows.filter((r: any) => r.type === '冲销')).toHaveLength(2)
    expect(deliveryRows.filter((r: any) => r.type === '冲销')[0]).toMatchObject({ inQty: 0.25, inAmount: 0.75, outSettlementPrice: 5, outSettlementAmount: -1.25, outProfit: -0.5 })
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outQty - row.inQty, 0)).toBe(3.5)
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outAmount - (row.inAmount || 0), 0)).toBe(10.5)
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outSettlementAmount, 0)).toBe(17.5)
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outProfit, 0)).toBe(7)
    expect((await report('realtime', '&ranges=not-json')).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/inventory-reports/summary?start=2026-02-30&end=2026-09-21', headers: headers() })).statusCode).toBe(400)
    expect((await report('realtime', `&ranges=${encodeURIComponent(JSON.stringify({ amount: { min: 230 } }))}`)).json().total).toBe(0)
  })
  it('keeps delivery economics on each physical row and isolates period and warehouse scopes', async () => {
    const request = (start: string, end: string, warehouse = '') => app.inject({
      url: `/api/inventory-reports/movements?start=${start}&end=${end}${warehouse ? `&warehouseId=${warehouse}` : ''}`,
      headers: headers(),
    })
    const totals = (rows: any[]) => ({
      quantity: rows.reduce((sum, row) => sum + row.outQty - row.inQty, 0),
      cost: rows.reduce((sum, row) => sum + row.outAmount - (row.inAmount || 0), 0),
      settlement: rows.reduce((sum, row) => sum + row.outSettlementAmount, 0),
      profit: rows.reduce((sum, row) => sum + row.outProfit, 0),
    })
    const september = (await request('2026-09-01', '2026-09-30')).json().rows.filter((row: any) => row.code === 'REPORT-02')
    expect(totals(september)).toEqual({ quantity: 3.5, cost: 10.5, settlement: 17.5, profit: 7 })
    const october = (await request('2026-10-01', '2026-10-02')).json().rows.filter((row: any) => row.code === 'REPORT-02')
    expect(october).toHaveLength(1)
    expect(october[0]).toMatchObject({ warehouse: '二号仓', type: '冲销', inQty: 0.25, inAmount: 0.75, outSettlementAmount: -1.25, outProfit: -0.5 })
    const fullRows = (await request('2026-09-01', '2026-10-02')).json().rows
    const full = fullRows.filter((row: any) => row.code === 'REPORT-02')
    expect(totals(full)).toEqual({ quantity: 3.25, cost: 9.75, settlement: 16.25, profit: 6.5 })
    const wrongProductReversal = fullRows.find((row: any) => row.doc?.startsWith('wrong-product-'))
    expect(wrongProductReversal).toMatchObject({ code: 'REPORT-01', inAmount: null, outSettlementAmount: null, outSettlementPrice: null, outProfit: null })
    const firstWarehouse = (await request('2026-09-01', '2026-09-30', warehouseId)).json().rows.filter((row: any) => row.code === 'REPORT-02')
    expect(totals(firstWarehouse)).toEqual({ quantity: 1.5, cost: 4.5, settlement: 7.5, profit: 3 })
    const secondWarehouse = (await request('2026-09-01', '2026-09-30', secondWarehouseId)).json().rows.filter((row: any) => row.code === 'REPORT-02')
    expect(totals(secondWarehouse)).toEqual({ quantity: 2, cost: 6, settlement: 10, profit: 4 })
  })
  it('rejects foreign stores, duplicates and invalid state transitions; retry is idempotent', async () => {
    expect((await create({ toStoreId: foreignStoreId })).statusCode).toBe(400)
    expect((await create({ toStoreId: fromStoreId })).statusCode).toBe(400)
    const key = randomUUID(); const res = await create({ requestKey: key }); expect(res.statusCode, res.body).toBe(201); const row = res.json()
    const replay = await create({ requestKey: key }); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().id).toBe(row.id)
    expect((await create({ requestKey: key, items: [{ productId, quantity: 4, cost: 2, settlement: 2.5 }] })).statusCode).toBe(409)
    expect(await prisma.storeTransfer.count({ where: { tenantId, requestKey: key } })).toBe(1)
    expect((await transition(row.id, 'RECEIVED')).statusCode).toBe(409)
    expect((await report('transfer-detail')).json().total).toBe(0)
    expect((await transition(row.id, 'SHIPPED')).statusCode).toBe(200)
    expect((await transition(row.id, 'SHIPPED')).statusCode).toBe(200)
    expect((await transition(row.id, 'REVOKED')).statusCode).toBe(409)
    expect((await transition(row.id, 'RECEIVED')).statusCode).toBe(200)
    const reread = (await app.inject({ url: '/api/store-transfers', headers: headers() })).json()[0]
    expect(reread.status).toBe('RECEIVED'); expect(reread.createdById).toBe(userId); expect(reread.shippedById).toBe(userId)
    expect((await report('transfer-detail')).json().rows[0]).toMatchObject({ date: '2026-09-21', transferQty: 3, outAmount: 6, inAmount: 7.5, org: '调出门店', target: '调入门店' })
    expect((await app.inject({ url: `/api/store-transfers/${row.id}/status`, method: 'PATCH', headers: headers(foreignToken), payload: { status: 'SHIPPED' } })).statusCode).toBe(404)
  })
  it('normalizes item order and decimals, and safely serializes concurrent idempotent creates', async () => {
    const orderedItems = [
      { productId, quantity: 2, cost: 3, settlement: 3.5 },
      { productId: secondProductId, quantity: 1, cost: 4, settlement: 4.5 },
    ]
    const orderKey = randomUUID()
    const first = await create({ requestKey: orderKey, note: '  顺序测试  ', items: orderedItems })
    expect(first.statusCode, first.body).toBe(201)
    const reordered = await create({ requestKey: orderKey, note: '顺序测试', items: [...orderedItems].reverse() })
    expect(reordered.statusCode, reordered.body).toBe(200)
    expect(reordered.json().id).toBe(first.json().id)

    const concurrentKey = randomUUID()
    const [left, right] = await Promise.all([
      create({ requestKey: concurrentKey }),
      create({ requestKey: concurrentKey }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 201])
    expect(left.json().id).toBe(right.json().id)
    expect(await prisma.storeTransfer.count({ where: { tenantId, requestKey: concurrentKey } })).toBe(1)

    const conflictingKey = randomUUID()
    const [one, two] = await Promise.all([
      create({ requestKey: conflictingKey, items: [{ productId, quantity: 2, cost: 2, settlement: 2.5 }] }),
      create({ requestKey: conflictingKey, items: [{ productId, quantity: 3, cost: 2, settlement: 2.5 }] }),
    ])
    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409])
    expect(await prisma.storeTransfer.count({ where: { tenantId, requestKey: conflictingKey } })).toBe(1)
  })
  it('aggregates weighted prices before filtering, excludes revoked and pending transfers', async () => {
    const second = (await create({ items: [{ productId, quantity: 1, cost: 6, settlement: 7.5 }] })).json()
    await transition(second.id, 'SHIPPED')
    const revoked = (await create()).json(); expect((await transition(revoked.id, 'REVOKED')).statusCode).toBe(200)
    expect((await transition(revoked.id, 'SHIPPED')).statusCode).toBe(409)
    const row = (await report('transfer-summary', `&ranges=${encodeURIComponent(JSON.stringify({ transferQty: { min: 4 } }))}`)).json().rows[0]
    expect(row).toMatchObject({ transferQty: 4, outAmount: 12, inAmount: 15, cost: 3, settlement: 3.75 })
    expect((await report('transfer-detail', '', foreignToken)).json().total).toBe(0)
  })
  it('exports all filtered rows with the same numbers as the report', async () => {
    const res = await report('transfer-detail', '&pageSize=1&export=1'); expect(res.statusCode).toBe(200)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(res.json().fileBase64, 'base64') as any)
    const sheet = workbook.worksheets[0]; expect(sheet.rowCount).toBe(3)
    const plain = (await report('transfer-detail')).json(); expect(res.json().total).toBe(plain.total)
    const quantityColumn = plain.columns.findIndex((c: any) => c.key === 'transferQty') + 1
    expect(sheet.getRow(2).getCell(quantityColumn).value).toBe(plain.rows[0].transferQty)
  })
  it('separates business/base units, keeps unknown tax/audit facts empty, and calculates weighted inventory prices', async () => {
    const r = (await report('movements')).json().rows.find((r: any) => r.inBaseQty === 5)
    expect(r).toMatchObject({ unit: '箱', baseUnit: 'kg', inQty: 0.5, inBaseQty: 5, inAmount: null, inPrice: null, reviewedAt: null, outProfit: null })
    const deliveryRows = (await report('movements')).json().rows.filter((row: any) => row.code === 'REPORT-02')
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outAmount - (row.inAmount || 0), 0)).toBe(10.5)
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outSettlementAmount, 0)).toBe(17.5)
    expect(deliveryRows.reduce((sum: number, row: any) => sum + row.outProfit, 0)).toBe(7)
    expect((await report('realtime')).json().rows[0]).toMatchObject({ conversion: 1, qty: 112, netAmount: null, netPrice: null })
    expect((await report('summary')).json().rows[0]).toMatchObject({ openingPrice: 2, inPrice: 3, outPrice: 2 })
  })
  it('serves other movements, stagnation and alerts with tenant and role isolation', async () => {
    expect((await report('other-summary')).json().rows[0]).toMatchObject({ baseUnit: 'kg', quantity: 5, amount: 15, type: '手工入库' })
    expect((await report('stagnant', '&stagnantDays=36500')).json().rows[0]).toMatchObject({ qty: 112, stagnantDays: 36500, isStagnant: '否', lastInQty: 99, lastOutQty: 2 })
    expect((await report('alerts')).json().rows[0]).toMatchObject({ qty: 112, minQty: null, maxQty: null, alertStatus: '阈值未配置' })
    expect((await report('stagnant', '&stagnantDays=0')).statusCode).toBe(400)
    for (const id of ['other-summary', 'stagnant', 'alerts']) {
      expect((await report(id, '', supplierToken)).statusCode).toBe(403)
      expect((await report(id, '', financeToken)).statusCode).toBe(200)
      expect((await report(id, '', foreignToken)).json().total).toBe(0)
    }
  })
  it('persists warehouse-scoped rules with CAS, idempotency, audit snapshots and tenant isolation', async () => {
    const requestId = randomUUID()
    const created = await savePolicy({ minQty: 100, maxQty: 120, stagnantDays: 36500, active: true, rowVersion: 0, requestId })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json()).toMatchObject({ replayed: false, policy: { inventoryUnitSnapshot: 'kg', minQty: 100, maxQty: 120, stagnantDays: 36500, active: true, rowVersion: 0 } })
    const replay = await savePolicy({ minQty: 100, maxQty: 120, stagnantDays: 36500, active: true, rowVersion: 0, requestId })
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().replayed).toBe(true)
    expect((await savePolicy({ minQty: 100, maxQty: 121, stagnantDays: 36500, active: true, rowVersion: 0, requestId })).statusCode).toBe(409)

    const second = await savePolicy({ warehouseId: secondWarehouseId, minQty: 5, maxQty: 10, stagnantDays: 20, active: true, rowVersion: 0, requestId: randomUUID() })
    expect(second.statusCode, second.body).toBe(200)
    const policies = (await listPolicies()).json()
    expect(policies.items.find((item: any) => item.productId === productId)).toMatchObject({ minQty: 100, maxQty: 120, stagnantDays: 36500, source: 'configured' })
    expect((await listPolicies(`?warehouseId=${secondWarehouseId}`)).json().items.find((item: any) => item.productId === productId)).toMatchObject({ minQty: 5, maxQty: 10, stagnantDays: 20 })
    expect((await listPolicies('', foreignToken)).json().total).toBe(0)
    expect((await savePolicy({ minQty: 1, maxQty: 2, stagnantDays: 30, active: true, rowVersion: 0, requestId: randomUUID() }, productId, foreignToken)).statusCode).toBe(403)

    const event = await prisma.warehouseInventoryPolicyEvent.findFirstOrThrow({ where: { tenantId, requestId } })
    expect(event.beforeValue).toBeNull()
    expect(event.afterValue).toMatchObject({ inventoryUnitSnapshot: 'kg', minQty: 100, maxQty: 120, stagnantDays: 36500, active: true, rowVersion: 0 })
    expect(event.actorId).toBe(userId); expect(event.actorRole).toBe('SUPPLY_CHAIN')
  })
  it('uses configured limits and per-product stagnation without mutating stock or configuration', async () => {
    expect((await report('alerts')).json().rows[0]).toMatchObject({ qty: 112, minQty: 100, maxQty: 120, alertStatus: '正常' })
    const existing = await prisma.warehouseInventoryPolicy.findFirstOrThrow({ where: { tenantId, warehouseId, productId } })
    const high = await savePolicy({ minQty: 90, maxQty: 110, stagnantDays: 36500, active: true, rowVersion: existing.rowVersion, requestId: randomUUID() })
    expect(high.statusCode, high.body).toBe(200)
    expect((await report('alerts')).json().rows[0].alertStatus).toBe('高于上限')
    const movementCount = await prisma.warehouseLedgerMovement.count({ where: { tenantId } })
    expect((await report('stagnant')).json().rows[0]).toMatchObject({ stagnantDays: 36500, isStagnant: '否' })
    expect((await report('stagnant', '&stagnantDays=1')).json().rows[0]).toMatchObject({ stagnantDays: 1, isStagnant: '是' })
    expect((await prisma.warehouseInventoryPolicy.findFirstOrThrow({ where: { tenantId, warehouseId, productId } })).stagnantDays).toBe(36500)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId } })).toBe(movementCount)
  })
  it('does not revive legacy minStock after a warehouse policy is explicitly disabled', async () => {
    await prisma.warehouseLedgerBalance.create({ data: { tenantId, warehouseId: secondWarehouseId, productId, inventoryUnit: 'kg', physicalQty: 5, reservedQty: 0, inventoryValue: 10, averageUnitCost: 2 } })
    await prisma.product.update({ where: { id: productId }, data: { minStock: 99 } })
    const policy = await prisma.warehouseInventoryPolicy.findFirstOrThrow({ where: { tenantId, warehouseId: secondWarehouseId, productId } })
    const disabled = await savePolicy({ warehouseId: secondWarehouseId, minQty: 5, maxQty: 10, stagnantDays: 20, active: false, rowVersion: policy.rowVersion, requestId: randomUUID() })
    expect(disabled.statusCode, disabled.body).toBe(200)
    expect((await report('alerts', `&warehouseId=${secondWarehouseId}`)).json().rows[0]).toMatchObject({ qty: 5, minQty: null, maxQty: null, alertStatus: '阈值未配置' })
    await prisma.warehouseLedgerBalance.delete({ where: { tenantId_warehouseId_productId: { tenantId, warehouseId: secondWarehouseId, productId } } })
    await prisma.product.update({ where: { id: productId }, data: { minStock: 0 } })
  })
  it('replays concurrent identical requestIds and rejects concurrent conflicting content', async () => {
    const sameRequestId = randomUUID()
    const samePayload = { minQty: 1, maxQty: 10, stagnantDays: 30, active: true, rowVersion: 0, requestId: sameRequestId }
    const [first, duplicate] = await Promise.all([
      savePolicy(samePayload, secondProductId),
      savePolicy(samePayload, secondProductId),
    ])
    expect([first.statusCode, duplicate.statusCode]).toEqual([200, 200])
    expect([first.json().replayed, duplicate.json().replayed].sort()).toEqual([false, true])
    expect(await prisma.warehouseInventoryPolicyEvent.count({ where: { tenantId, requestId: sameRequestId } })).toBe(1)

    const conflictRequestId = randomUUID()
    const [one, two] = await Promise.all([
      savePolicy({ warehouseId: secondWarehouseId, minQty: 1, maxQty: 10, stagnantDays: 30, active: true, rowVersion: 0, requestId: conflictRequestId }, secondProductId),
      savePolicy({ warehouseId: secondWarehouseId, minQty: 1, maxQty: 11, stagnantDays: 30, active: true, rowVersion: 0, requestId: conflictRequestId }, secondProductId),
    ])
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409])
    expect(await prisma.warehouseInventoryPolicyEvent.count({ where: { tenantId, requestId: conflictRequestId } })).toBe(1)
  })
  it('rejects stale concurrent policy writes with 409', async () => {
    const existing = await prisma.warehouseInventoryPolicy.findFirstOrThrow({ where: { tenantId, warehouseId, productId } })
    const [left, right] = await Promise.all([
      savePolicy({ minQty: 80, maxQty: 115, stagnantDays: 40, active: true, rowVersion: existing.rowVersion, requestId: randomUUID() }),
      savePolicy({ minQty: 85, maxQty: 116, stagnantDays: 41, active: true, rowVersion: existing.rowVersion, requestId: randomUUID() }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409])
  })
  it('keeps all eight report field orders consistent with export; serials continue across pages', async () => {
    for (const id of reportIds) {
      const plain = (await report(id)).json()
      expect(plain.columns.map((c: any) => c.label)).toEqual(fieldContract.find(r => r.id === id)!.columns.map(c => c.label))
      const exported = (await report(id, '&export=1')).json()
      const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
      expect(book.worksheets[0].getRow(1).values).toEqual([undefined, ...plain.columns.map((c: any) => c.label)])
      for (const [i, row] of plain.rows.entries()) {
        expect(row.seq).toBe(i + 1)
        for (const [j, col] of plain.columns.entries()) expect(book.worksheets[0].getRow(i + 2).getCell(j + 1).value ?? null).toEqual(row[col.key] ?? null)
      }
    }
    expect((await report('movements', '&pageSize=1&page=2')).json().rows[0].seq).toBe(2)
  })

})
