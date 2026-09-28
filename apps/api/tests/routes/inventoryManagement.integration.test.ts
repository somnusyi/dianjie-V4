import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { prisma } from '@dianjie/db'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { inventoryManagementRoutes } from '../../src/routes/inventoryManagement'
import { warehouseInventoryRoutes } from '../../src/routes/warehouseInventory'
import { warehouseDocsRoutes } from '../../src/routes/warehouseDocs'
import { managementPages } from '../../src/services/inventoryManagement'

vi.mock('../../src/routes/upload', () => ({
  assertWarehouseDocumentObjects: vi.fn(async () => undefined),
  signOssKey: vi.fn((key: string) => `https://evidence.local/${encodeURIComponent(key)}`),
}))

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
    const outbound = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-manual-outbound', headers: headers(), payload: { items: [{ productId, inventoryQuantity: 5 }], effectiveAt: date, idempotencyKey: randomUUID(), purpose: 'SAMPLE_ISSUE', reason: '本地联调领用' } })
    expect(outbound.statusCode, outbound.body).toBe(200)
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({ where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } } })
    expect(Number(balance.physicalQty)).toBe(15); expect(Number(balance.inventoryValue)).toBe(150)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId } })).toBe(2)
    const inRows = (await get('other-in')).json().rows; const outRows = (await get('other-out')).json().rows
    expect(inRows).toHaveLength(1); expect(outRows).toHaveLength(1)
    expect(inRows[0]).toMatchObject({ amount: 200, warehouse: '验证总仓', creator: '验证操作员', status: '未审核', source: '其他入库', attachments: '0 项' })
    expect(outRows[0]).toMatchObject({ amount: 50, reason: '【样品领用】本地联调领用' })
    inboundNo = inRows[0].no; outboundNo = outRows[0].no
    expect((await get('limits')).json().rows[0]).toMatchObject({ currentQty: 15, unit: 'kg', minQty: null, safeQty: null })
  })
  it('总仓自损只能走独立端点，并在扣库前强制责任归属和现场证据', async () => {
    const genericBypass = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-manual-outbound', headers: headers(), payload: { items: [{ productId, inventoryQuantity: 1 }], effectiveAt: date, idempotencyKey: randomUUID(), purpose: 'SELF_LOSS', reason: '过期处理' } })
    expect(genericBypass.statusCode).toBe(400)
    expect(genericBypass.json().error).toContain('Invalid enum value')
    const base = { items: [{ productId, inventoryQuantity: 1 }], effectiveAt: date, idempotencyKey: randomUUID(), reason: '过期变质' }
    const missingResponsibility = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(), payload: base })
    expect(missingResponsibility.statusCode).toBe(400)
    expect(missingResponsibility.json().error).toContain('责任归属')
    const missingEvidence = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(), payload: { ...base, responsibility: '仓储环节' } })
    expect(missingEvidence.statusCode).toBe(400)
    expect(missingEvidence.json().error).toContain('现场证据')

    await prisma.warehouseLedgerBalance.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
      data: { reservedQty: 10 },
    })
    const idempotencyKey = randomUUID()
    const evidenceKey = `warehouse-docs/${tenantId}/self-loss-proof.jpg`
    const payload = {
      ...base,
      idempotencyKey,
      items: [{ productId, inventoryQuantity: 2, note: '报损现场已隔离' }],
      responsibility: '仓储环节',
      attachments: [{ key: evidenceKey, name: '自损现场.jpg', mime: 'image/jpeg', size: 1024 }],
    }
    const forbidden = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers('FINANCE'), payload })
    expect(forbidden.statusCode).toBe(403)
    const foreignAttachment = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers('ADMIN', otherTenantId), payload })
    expect(foreignAttachment.statusCode).toBe(403)
    const foreignProduct = await app.inject({
      method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers('ADMIN', otherTenantId),
      payload: { ...payload, idempotencyKey: randomUUID(), attachments: [{ ...payload.attachments[0], key: `warehouse-docs/${otherTenantId}/foreign-product-proof.jpg` }] },
    })
    expect(foreignProduct.statusCode).toBe(404)
    const [first, concurrentReplay] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(), payload }),
      app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(), payload }),
    ])
    expect(first.statusCode, first.body).toBe(200)
    expect(concurrentReplay.statusCode, concurrentReplay.body).toBe(200)
    const firstBody = first.json()
    const replayBody = concurrentReplay.json()
    expect(new Set([firstBody.replayed, replayBody.replayed])).toEqual(new Set([false, true]))
    expect(firstBody.doc.id).toBe(replayBody.doc.id)
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, sourceType: 'WarehouseSelfLoss', sourceId: idempotencyKey },
    })).toBe(1)
    expect(await prisma.warehouseDoc.count({
      where: { tenantId, idempotencyKey: `self-loss:${idempotencyKey}` },
    })).toBe(1)

    const sequentialReplay = await app.inject({ method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(), payload })
    expect(sequentialReplay.statusCode, sequentialReplay.body).toBe(200)
    expect(sequentialReplay.json().replayed).toBe(true)
    const changedRequest = await app.inject({
      method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(),
      payload: { ...payload, items: [{ productId, inventoryQuantity: 1, note: '报损现场已隔离' }] },
    })
    expect(changedRequest.statusCode).toBe(409)
    expect(changedRequest.json().error).toContain('幂等键')

    const reservedBlocked = await app.inject({
      method: 'POST', url: '/api/warehouse-inventory/batch-self-loss', headers: headers(),
      payload: { ...payload, idempotencyKey: randomUUID(), items: [{ productId, inventoryQuantity: 4 }] },
    })
    expect(reservedBlocked.statusCode).toBe(409)
    expect(reservedBlocked.json().error).toContain('可用总仓库存不足')

    const docDetail = await app.inject({ method: 'GET', url: `/api/warehouse-docs/${firstBody.doc.id}`, headers: headers() })
    expect(docDetail.statusCode, docDetail.body).toBe(200)
    expect(docDetail.json()).toMatchObject({
      reason: '总仓自损：过期变质',
      note: '责任归属：仓储环节',
      attachmentCount: 1,
      attachments: [{ name: '自损现场.jpg', mime: 'image/jpeg', size: 1024 }],
    })
    expect(docDetail.json().attachments[0].url).toContain(encodeURIComponent(evidenceKey))
    const exported = (await get('other-out', { export: '1' })).json()
    const exportBook = new ExcelJS.Workbook(); await exportBook.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
    const selfLossRow = (exportBook.worksheets[0].getRows(2, Math.max(1, exportBook.worksheets[0].rowCount - 1)) || [])
      .find(row => row.values.includes(firstBody.doc.docNo))
    expect(selfLossRow?.values).toEqual(expect.arrayContaining(['总仓自损：过期变质', 20]))
    // 现场证据在单据详情中可追溯，但不擅自改动已经用户逐页审核的导出字段。
    expect(selfLossRow?.values).not.toContain('1 项')
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(Number(balance.physicalQty)).toBe(13)
    expect(Number(balance.reservedQty)).toBe(10)
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
    const exportedRows = book.worksheets[0].getRows(2, Math.max(1, book.worksheets[0].rowCount - 1)) || []
    const originalOutboundRow = exportedRows.find(row => row.values.includes(outboundNo))
    expect(originalOutboundRow?.values).toContain(50)
    await prisma.$disconnect()
    expect((await get('other-in')).json().rows[0].no).toBe(inboundNo)
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({ where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } } })
    expect(Number(balance.physicalQty)).toBe(13)
    expect(Number(balance.reservedQty)).toBe(10)
  })
})
