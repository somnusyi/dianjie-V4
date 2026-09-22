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
let tenantId = '', otherTenantId = '', productId = '', warehouseId = '', fromStoreId = '', toStoreId = '', foreignStoreId = '', userId = ''
let token = '', supplierToken = '', foreignToken = '', financeToken = ''
const headers = (value = token) => ({ authorization: `Bearer ${value}` })
const query = 'start=2026-09-01&end=2026-09-21'
const report = (id: string, extra = '', t = token) => app.inject({ url: `/api/inventory-reports/${id}?${query}${extra}`, headers: headers(t) })
const create = (overrides: any = {}) => app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(), payload: { fromStoreId, toStoreId, transferDate: '2026-09-21', requestKey: randomUUID(), items: [{ productId, quantity: 3, cost: 2, settlement: 2.5 }], ...overrides } })
const transition = (id: string, status: string) => app.inject({ method: 'PATCH', url: `/api/store-transfers/${id}/status`, headers: headers(), payload: { status } })

describe('inventory reports and persistent store transfers', () => {
  beforeAll(async () => {
    const suffix = randomUUID()
    const tenant = await prisma.tenant.create({ data: { name: '报表测试', slug: `reports-${suffix}` } }); tenantId = tenant.id
    const other = await prisma.tenant.create({ data: { name: '隔离租户', slug: `other-${suffix}` } }); otherTenantId = other.id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: 'SUP', name: '测试供应商' } })
    const product = await prisma.product.create({ data: { tenantId, supplierId: supplier.id, code: 'REPORT-01', name: '测试土豆', price: 3, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: 10, orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', status: 'ENABLED' } }); productId = product.id
    userId = (await prisma.user.create({ data: { tenantId, email: 'report@local.test', name: '测试', password: 'test-only', role: 'SUPPLY_CHAIN' } })).id
    fromStoreId = (await prisma.store.create({ data: { tenantId, no: 'A', name: '调出门店' } })).id
    toStoreId = (await prisma.store.create({ data: { tenantId, no: 'B', name: '调入门店' } })).id
    foreignStoreId = (await prisma.store.create({ data: { tenantId: otherTenantId, no: 'C', name: '其他租户门店' } })).id
    for (const [date, qty, value, type] of [['2026-08-31T15:59:59Z', 10, 20, 'OPENING_BALANCE'], ['2026-08-31T16:00:00Z', 5, 15, 'MANUAL_INBOUND'], ['2026-09-21T15:59:59Z', -2, -4, 'ORDER_OUTBOUND'], ['2026-09-21T16:00:00Z', 99, 198, 'MANUAL_INBOUND']] as const) {
      await prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type, effectiveAt: new Date(date), physicalDelta: qty, valueDelta: value, physicalAfter: 0, reservedAfter: 0, valueAfter: 0, averageUnitCostAfter: 0, originalQuantity: qty === 5 ? 0.5 : Math.abs(qty), originalUnit: qty === 5 ? '箱' : 'kg', conversionFactor: qty === 5 ? 10 : 1, inventoryQuantity: Math.abs(qty), inventoryUnit: 'kg', sourceType: qty === 5 ? 'WarehouseManualInbound' : 'ReportFixture', sourceId: randomUUID(), idempotencyKey: randomUUID() } })
    }
    await prisma.warehouseLedgerBalance.create({ data: { tenantId, warehouseId, productId, inventoryUnit: 'kg', physicalQty: 112, reservedQty: 2, inventoryValue: 229, averageUnitCost: 2.044643 } })
    await app.register(jwt, { secret: 'inventory-report-integration-secret-only' })
    app.decorate('authenticate', async (req: any) => { await req.jwtVerify() })
    await app.register(inventoryReportRoutes, { prefix: '/api/inventory-reports' }); await app.register(storeTransferRoutes, { prefix: '/api/store-transfers' })
    token = app.jwt.sign({ userId, tenantId, role: 'SUPPLY_CHAIN' }); supplierToken = app.jwt.sign({ userId, tenantId, role: 'SUPPLIER_OWNER' }); foreignToken = app.jwt.sign({ userId, tenantId: otherTenantId, role: 'ADMIN' }); financeToken = app.jwt.sign({ userId, tenantId, role: 'FINANCE' })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    if (!tenantId) return
    await prisma.storeTransferItem.deleteMany({ where: { transfer: { tenantId } } }); await prisma.storeTransfer.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } }); await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }); await prisma.warehouse.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }); await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
  })
  it('enforces authentication, role and tenant boundaries', async () => {
    expect((await app.inject('/api/inventory-reports/realtime')).statusCode).toBe(401)
    expect((await report('realtime', '', supplierToken)).statusCode).toBe(403)
    expect((await report('realtime', '', financeToken)).statusCode).toBe(200)
    expect((await report('realtime', '', foreignToken)).json().total).toBe(0)
    expect((await report('realtime', `&warehouseId=${warehouseId}`, foreignToken)).json().total).toBe(0)
    expect((await app.inject({ method: 'POST', url: '/api/store-transfers', headers: headers(financeToken), payload: {} })).statusCode).toBe(403)
  })
  it('reconciles Shanghai date boundaries and preserves complete balances with type filters', async () => {
    const response = await report('summary'); expect(response.statusCode).toBe(200)
    const row = response.json().rows[0]; expect(row).toMatchObject({ openingQty: 10, openingAmount: 20, inQty: 5, inAmount: 15, outQty: 2, outAmount: 4, closingQty: 13, closingAmount: 31 })
    expect((await report('summary', `&type=${encodeURIComponent('出库')}`)).json().rows[0]).toMatchObject({ openingQty: 10, closingQty: 13 })
  })
  it('does not mislabel unknown tax values, validates dates and numeric ranges', async () => {
    const rows = (await report('movements')).json().rows; expect(rows).toHaveLength(2)
    expect(rows.find((r: any) => r.inBaseQty === 5).inAmount).toBeNull()
    expect((await report('realtime', '&ranges=not-json')).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/inventory-reports/summary?start=2026-02-30&end=2026-09-21', headers: headers() })).statusCode).toBe(400)
    expect((await report('realtime', `&ranges=${encodeURIComponent(JSON.stringify({ amount: { min: 230 } }))}`)).json().total).toBe(0)
  })
  it('rejects foreign stores, duplicates and invalid state transitions; retry is idempotent', async () => {
    expect((await create({ toStoreId: foreignStoreId })).statusCode).toBe(400)
    expect((await create({ toStoreId: fromStoreId })).statusCode).toBe(400)
    const key = randomUUID(); const res = await create({ requestKey: key }); expect(res.statusCode, res.body).toBe(201); const row = res.json()
    expect((await create({ requestKey: key })).json().id).toBe(row.id)
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
    expect((await report('realtime')).json().rows[0]).toMatchObject({ conversion: 1, qty: 112, netAmount: null, netPrice: null })
    expect((await report('summary')).json().rows[0]).toMatchObject({ openingPrice: 2, inPrice: 3, outPrice: 2 })
  })
  it('serves other movements, stagnation and alerts with tenant and role isolation', async () => {
    expect((await report('other-summary')).json().rows[0]).toMatchObject({ baseUnit: 'kg', quantity: 5, amount: 15, type: '手工入库' })
    expect((await report('stagnant', '&stagnantDays=36500')).json().rows[0]).toMatchObject({ qty: 112, stagnantDays: 36500, isStagnant: '否', lastInQty: 99, lastOutQty: 2 })
    expect((await report('alerts')).json().rows[0]).toMatchObject({ qty: 112, minQty: 0, maxQty: null })
    expect((await report('stagnant', '&stagnantDays=0')).statusCode).toBe(400)
    for (const id of ['other-summary', 'stagnant', 'alerts']) {
      expect((await report(id, '', supplierToken)).statusCode).toBe(403)
      expect((await report(id, '', financeToken)).statusCode).toBe(200)
      expect((await report(id, '', foreignToken)).json().total).toBe(0)
    }
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
