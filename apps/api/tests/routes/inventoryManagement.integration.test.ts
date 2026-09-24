import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { prisma } from '@dianjie/db'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { inventoryManagementRoutes } from '../../src/routes/inventoryManagement'
import { warehouseInventoryRoutes } from '../../src/routes/warehouseInventory'
import { warehouseDocsRoutes } from '../../src/routes/warehouseDocs'
import { managementPages } from '../../src/services/inventoryManagement'

const app = Fastify()
let tenantId = '', otherTenantId = '', userId = '', supplierId = '', productId = '', warehouseId = '', storeId = ''
let inboundNo = '', outboundNo = ''
const date = '2026-09-22T02:00:00Z'
const headers = (role = 'SUPPLY_CHAIN', tenant = tenantId) => ({ authorization: `Bearer ${app.jwt.sign({ role, tenantId: tenant, userId })}` })
const get = (id: string, query: Record<string, string> = {}, role = 'SUPPLY_CHAIN', tenant = tenantId) => app.inject({ url: `/api/inventory-management/${id}?${new URLSearchParams(query)}`, headers: headers(role, tenant) })

describe('inventory management with real PostgreSQL', () => {
  beforeAll(async () => {
    const suffix = randomUUID()
    tenantId = (await prisma.tenant.create({ data: { name: '管理页集成测试', slug: `management-${suffix}` } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: '隔离租户', slug: `management-other-${suffix}` } })).id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { name: '验证总仓', inventoryMode: 'STRICT', inventoryActivatedAt: new Date() } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, no: 'SUP-MGMT', name: '验证供应商', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
    storeId = (await prisma.store.create({ data: { tenantId, no: 'STORE-MGMT', name: '验证门店' } })).id
    userId = (await prisma.user.create({ data: { tenantId, email: 'management@local.test', name: '验证操作员', role: 'SUPPLY_CHAIN', password: 'integration-only' } })).id
    productId = (await prisma.product.create({ data: { tenantId, code: 'MGMT-01', name: '验证土豆', price: 10, unit: 'kg', purchaseUnit: '箱', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 10, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' } })).id
    const order = await prisma.upstreamPurchaseOrder.create({ data: { tenantId, no: 'PO-MGMT', supplierId, warehouseId, createdById: userId } })
    await prisma.upstreamReceipt.create({ data: { tenantId, no: 'IN-MGMT', purchaseOrderId: order.id, supplierId, warehouseId, createdById: userId,
      status: 'POSTED', postedAt: new Date(date), payableAmount: 123.45, evidence: [{ name: '本地测试凭证' }], note: '读取字段集成测试' } })
    await prisma.inventoryCount.create({ data: { tenantId, storeId, no: 'COUNT-MGMT', countDate: new Date('2026-09-22T00:00:00Z'), status: 'CONFIRMED', createdById: userId,
      itemCount: 1, countedCount: 1, differenceCount: 1, totalBookValue: 100, totalCountedValue: 90, totalDifferenceValue: -10, confirmedAt: new Date(date),
      items: { create: { productId, productCodeSnapshot: 'MGMT-01', productNameSnapshot: '验证土豆', unitSnapshot: 'kg', bookQuantity: 10, countedQuantity: 9, averageUnitCost: 10, differenceQuantity: -1, differenceAmount: -10, sortOrder: 0 } },
    } })
    await app.register(jwt, { secret: 'management-postgres-integration-secret' })
    app.decorate('authenticate', async (req: any) => req.jwtVerify())
    await app.register(inventoryManagementRoutes, { prefix: '/api/inventory-management' })
    await app.register(warehouseInventoryRoutes, { prefix: '/api/warehouse-inventory' })
    await app.register(warehouseDocsRoutes, { prefix: '/api/warehouse-docs' })
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
    if (!tenantId) return
    await prisma.inventoryCount.deleteMany({ where: { tenantId } })
    await prisma.upstreamReceipt.deleteMany({ where: { tenantId } })
    await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.warehouseDocLine.deleteMany({ where: { tenantId } })
    await prisma.warehouseDocLog.deleteMany({ where: { tenantId } })
    await prisma.warehouseDoc.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.warehouse.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
  })

  it('真实入库、出库接口写入单据、余额和流水；重试不会重复入账', async () => {
    const payload = { productId, supplierId, purchaseQuantity: 2, totalAmount: 200, effectiveAt: date, idempotencyKey: randomUUID(), note: '管理页真实接口测试' }
    const inbound = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/manual-inbound', headers: headers(), payload })
    expect(inbound.statusCode, inbound.body).toBe(200)
    const replay = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/manual-inbound', headers: headers(), payload })
    expect([200, 201]).toContain(replay.statusCode)
    const outbound = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-manual-outbound', headers: headers(), payload: { items: [{ productId, inventoryQuantity: 5 }], effectiveAt: date, idempotencyKey: randomUUID(), reason: '本地联调领用' } })
    expect(outbound.statusCode, outbound.body).toBe(200)
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({ where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } } })
    expect(Number(balance.physicalQty)).toBe(15); expect(Number(balance.inventoryValue)).toBe(150)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId } })).toBe(2)
    const inRows = (await get('other-in')).json().rows; const outRows = (await get('other-out')).json().rows
    expect(inRows).toHaveLength(1); expect(outRows).toHaveLength(1)
    expect(inRows[0]).toMatchObject({ amount: 200, warehouse: '验证总仓', creator: '验证操作员', status: '未审核' })
    expect(outRows[0]).toMatchObject({ amount: 50, reason: '本地联调领用' })
    inboundNo = inRows[0].no; outboundNo = outRows[0].no
    expect((await get('limits')).json().rows[0]).toMatchObject({ currentQty: 15, unit: 'kg', minQty: null, safeQty: null })
  })
  it('审核写入后管理页和数据库一致', async () => {
    const doc = await prisma.warehouseDoc.findFirstOrThrow({ where: { tenantId, docNo: inboundNo } })
    const audit = await app.inject({ method: 'POST', url: `/api/warehouse-docs/${doc.id}/confirm`, headers: headers('ADMIN') })
    expect(audit.statusCode, audit.body).toBe(200)
    expect((await get('other-in')).json().rows[0].status).toBe('已审核')
    expect((await prisma.warehouseDoc.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('CONFIRMED')
  })
  it('采购关联查询、附件与日期读取来自真实记录', async () => {
    const response = await get('purchase-in', { start: '2026-09-22', end: '2026-09-22' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().rows[0]).toMatchObject({ no: 'IN-MGMT', upstream: 'PO-MGMT', date: '2026-09-22', supplier: '验证供应商', amount: 123.45, attachments: '1 项', review: null })
    expect((await get('purchase-in', { start: '2026-09-23' })).json().total).toBe(0)
  })
  it('盘点筛选和金额与数据库一致，未记录仓库保持空值', async () => {
    const response = await get('count', { filters: JSON.stringify({ item: '验证土豆', difference: '有差异' }), start: '2026-09-22', end: '2026-09-22' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().rows[0]).toMatchObject({ no: 'COUNT-MGMT', org: '验证门店', warehouse: null, bookAmount: 100, actualAmount: 90, differenceAmount: -10, auditedAt: '2026-09-22' })
    expect((await get('count', { start: '2026-09-21', end: '2026-09-21' })).json().total).toBe(0)
    expect((await get('count', { start: '2026-09-23', end: '2026-09-23' })).json().total).toBe(0)
    expect((await get('count', { filters: JSON.stringify({ item: '不存在的物品' }) })).json().total).toBe(0)
  })
  it('所有 9 页通过真实数据库查询；不同角色和租户受到隔离', async () => {
    for (const p of managementPages) {
      expect((await get(p.id)).statusCode).toBe(200)
      expect((await get(p.id, {}, 'ADMIN')).statusCode).toBe(200)
      expect((await get(p.id, {}, 'SUPPLIER_OWNER')).statusCode).toBe(403)
      expect((await get(p.id, {}, 'MANAGER')).statusCode).toBe(403)
      const foreign = await get(p.id, {}, 'ADMIN', otherTenantId)
      expect(foreign.statusCode).toBe(200); expect(foreign.json().rows).toEqual([])
    }
    expect((await app.inject('/api/inventory-management/count')).statusCode).toBe(401)
  })
  it('Excel 包含真实单号和金额，数据库重连后记录仍存在', async () => {
    const file = (await get('other-out', { export: '1' })).json()
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(file.fileBase64, 'base64') as any)
    expect(book.worksheets[0].getRow(2).values).toContain(outboundNo)
    expect(book.worksheets[0].getRow(2).values).toContain(50)
    await prisma.$disconnect()
    expect((await get('other-in')).json().rows[0].no).toBe(inboundNo)
    expect(Number((await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId } })).physicalQty)).toBe(15)
  })
})
