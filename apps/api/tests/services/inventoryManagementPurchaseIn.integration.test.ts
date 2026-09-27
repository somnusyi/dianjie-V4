import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { randomUUID } from 'node:crypto'
import { loadInventoryManagement, managementQuerySchema } from '../../src/services/inventoryManagement'

const suffix = `pil-${Date.now()}-${randomUUID().slice(0, 8)}`
let tenantId = ''
let otherTenantId = ''
let warehouseId = ''
let otherWarehouseId = ''
let supplierId = ''
let otherSupplierId = ''
let userId = ''
let productId = ''

const query = (input: Record<string, unknown> = {}) => managementQuerySchema.parse({
  start: '', end: '', dateField: 'date', filters: '{}', page: 1, pageSize: 20, ...input,
})

const sourceCounts = () => Promise.all([
  prisma.warehouseDoc.count({ where: { tenantId } }),
  prisma.warehouseDocLine.count({ where: { tenantId } }),
  prisma.warehouseLedgerMovement.count({ where: { tenantId } }),
  prisma.warehouseLedgerBalance.count({ where: { tenantId } }),
])

async function cleanup(id: string) {
  if (!id) return
  await prisma.warehouseDocLine.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseDoc.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamReceiptLine.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamReceipt.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseOrderLine.deleteMany({ where: { tenantId: id } })
  await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId: id } })
  await prisma.product.deleteMany({ where: { tenantId: id } })
  await prisma.user.deleteMany({ where: { tenantId: id } })
  await prisma.supplier.deleteMany({ where: { tenantId: id } })
  await prisma.warehouse.deleteMany({ where: { tenantId: id } })
  await prisma.tenant.deleteMany({ where: { id } })
}

describe('purchase-in inventory management source coverage (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `采购入库合并 ${suffix}`, slug: suffix } })
    const other = await prisma.tenant.create({ data: { name: `隔离采购入库 ${suffix}`, slug: `other-${suffix}` } })
    tenantId = tenant.id; otherTenantId = other.id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
    otherWarehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId: otherTenantId, isDefault: true } })).id
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { name: '合并测试仓' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '当前供应商名', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
    otherSupplierId = (await prisma.supplier.create({ data: { tenantId: otherTenantId, no: `OTHER-${suffix}`, name: '其他租户供应商', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
    userId = (await prisma.user.create({ data: { tenantId, name: '合并测试经办人', email: `${suffix}@local.test`, password: 'test-only', role: 'SUPPLY_CHAIN' } })).id
    productId = (await prisma.product.create({ data: { tenantId, code: `P-${suffix}`, name: '采购土豆', unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 1 } })).id

    const order = await prisma.upstreamPurchaseOrder.create({ data: {
      tenantId, no: `PO-${suffix}`, supplierId, warehouseId, createdById: userId,
      lines: { create: { lineNo: 1, productId, productCodeSnapshot: `P-${suffix}`, productNameSnapshot: '采购土豆', purchaseUnit: 'kg', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, orderedQty: 3, confirmedQty: 3, unitPrice: 10, amountWithoutTax: 30, taxAmount: 0, totalAmount: 30 } },
    }, include: { lines: true } })
    await prisma.upstreamReceipt.create({ data: {
      id: `receipt-${suffix}`, tenantId, no: `RC-${suffix}`, purchaseOrderId: order.id, supplierId, warehouseId, createdById: userId,
      status: 'POSTED', postedAt: new Date('2026-09-23T02:00:00Z'), createdAt: new Date('2026-09-20T02:00:00Z'), payableAmount: 30,
      evidence: [{ kind: 'claim-proof' }], note: '收货凭证保留',
      lines: { create: { purchaseOrderLineId: order.lines[0].id, productId, orderedQty: 3, arrivedQty: 3, acceptedQty: 3, purchaseUnit: 'kg', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryAcceptedQty: 3, unitPrice: 10, payableAmount: 30 } },
    } })
    await prisma.warehouseDoc.createMany({ data: [
      { id: `manual-new-${suffix}`, tenantId, docNo: `MI-NEW-${suffix}`, type: 'MANUAL_INBOUND', warehouseId, supplierId, supplierName: '历史供应商快照', attachments: [{ key: `warehouse-docs/${tenantId}/delivery.pdf`, name: '送货单.pdf', mime: 'application/pdf', size: 100 }], effectiveAt: new Date('2026-09-24T02:00:00Z'), createdAt: new Date('2026-09-21T02:00:00Z'), totalAmount: 20, status: 'POSTED', reviewStatus: 'REVIEWED', createdById: userId, note: '快照不得覆盖', idempotencyKey: `new-${suffix}` },
      { id: `manual-tie-${suffix}`, tenantId, docNo: `MI-TIE-${suffix}`, type: 'MANUAL_INBOUND', warehouseId, supplierId, supplierName: null, effectiveAt: new Date('2026-09-23T02:00:00Z'), createdAt: new Date('2026-09-22T02:00:00Z'), totalAmount: 40, status: 'CONFIRMED', reviewStatus: 'UNREVIEWED', createdById: null, idempotencyKey: `tie-${suffix}` },
      { id: `manual-no-supplier-${suffix}`, tenantId, docNo: `MI-NO-SUP-${suffix}`, type: 'MANUAL_INBOUND', warehouseId, supplierId: null, supplierName: '不应显示', effectiveAt: new Date('2026-09-25T02:00:00Z'), totalAmount: 999, idempotencyKey: `no-supplier-${suffix}` },
      { id: `manual-foreign-${suffix}`, tenantId: otherTenantId, docNo: `MI-FOREIGN-${suffix}`, type: 'MANUAL_INBOUND', warehouseId: otherWarehouseId, supplierId: otherSupplierId, supplierName: '其他租户快照', effectiveAt: new Date('2026-09-26T02:00:00Z'), totalAmount: 888, idempotencyKey: `foreign-${suffix}` },
    ] })
    await prisma.warehouseDocLine.createMany({ data: [
      { tenantId, docId: `manual-new-${suffix}`, lineNo: 1, productId, productName: '手工土豆', quantity: 2, unit: 'kg', unitPrice: 10, amount: 20, inventoryQuantity: 2, inventoryUnit: 'kg' },
      { tenantId, docId: `manual-tie-${suffix}`, lineNo: 1, productId, productName: '手工土豆', quantity: 4, unit: 'kg', unitPrice: 10, amount: 40, inventoryQuantity: 4, inventoryUnit: 'kg' },
    ] })
  })

  afterAll(async () => {
    await cleanup(otherTenantId)
    await cleanup(tenantId)
    await prisma.$disconnect()
  })

  it('merges, maps and deterministically sorts both sources without losing historical evidence semantics', async () => {
    const countsBefore = await sourceCounts()
    const result = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query()))
    expect(result.total).toBe(3)
    expect(result.totals.amount).toBe(90)
    expect(result.rows.map(row => row.id)).toEqual([
      `warehouse-doc:manual-new-${suffix}`,
      `receipt:receipt-${suffix}`,
      `warehouse-doc:manual-tie-${suffix}`,
    ])
    expect(result.rows[0]).toMatchObject({ no: `MI-NEW-${suffix}`, supplier: '历史供应商快照', status: '已入库', review: '已复审', upstream: null, attachments: '1 项', creator: '合并测试经办人' })
    expect(result.rows[1]).toMatchObject({ no: `RC-${suffix}`, supplier: '当前供应商名', status: '已入库', review: null, upstream: `PO-${suffix}`, attachments: '1 项' })
    expect(result.rows[2]).toMatchObject({ supplier: null, review: '未复审', attachments: null, creator: null })
    expect(result.options.supplier).toEqual(['历史供应商快照', '当前供应商名'])
    expect(result.options.review).toEqual(['已复审', '未复审'])
    const otherIn = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'other-in', query()))
    expect(otherIn.rows.map(row => row.no)).toContain(`MI-NEW-${suffix}`)
    await expect(sourceCounts()).resolves.toEqual(countsBefore)
  })

  it('applies filters, combined pagination, summaries and export to the same merged set', async () => {
    const countsBefore = await sourceCounts()
    const page = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query({ page: 2, pageSize: 2 })))
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2, totals: { amount: 90 } })
    expect(page.rows[0]).toMatchObject({ seq: 3, no: `MI-TIE-${suffix}` })

    for (const [filters, expected] of [
      [{ supplier: '历史供应商' }, [`MI-NEW-${suffix}`]],
      [{ review: '已复审' }, [`MI-NEW-${suffix}`]],
      [{ upstream: `PO-${suffix}` }, [`RC-${suffix}`]],
      [{ no: 'MI-TIE' }, [`MI-TIE-${suffix}`]],
      [{ status: '已入库' }, [`MI-NEW-${suffix}`, `RC-${suffix}`, `MI-TIE-${suffix}`]],
      [{ note: '快照不得' }, [`MI-NEW-${suffix}`]],
      [{ warehouse: '合并测试', item: '土豆' }, [`MI-NEW-${suffix}`, `RC-${suffix}`, `MI-TIE-${suffix}`]],
    ] as const) {
      const filtered = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query({ filters: JSON.stringify(filters) })))
      expect(filtered.rows.map(row => row.no)).toEqual(expected)
    }

    const dateFiltered = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query({ start: '2026-09-24', end: '2026-09-24' })))
    expect(dateFiltered.rows.map(row => row.no)).toEqual([`MI-NEW-${suffix}`])
    const createdFiltered = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query({ start: '2026-09-20', end: '2026-09-20', dateField: 'createdAt' })))
    expect(createdFiltered.rows.map(row => row.no)).toEqual([`RC-${suffix}`])

    const exported = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query({ pageSize: 1, export: '1' })))
    expect(exported.rows).toHaveLength(3)
    expect(exported.rows.map(row => row.no)).toEqual([`MI-NEW-${suffix}`, `RC-${suffix}`, `MI-TIE-${suffix}`])
    await expect(sourceCounts()).resolves.toEqual(countsBefore)
  })

  it('keeps warehouse documents tenant scoped', async () => {
    const own = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'purchase-in', query()))
    expect(own.rows.some(row => row.no === `MI-FOREIGN-${suffix}`)).toBe(false)
    const foreign = await prisma.$transaction(tx => loadInventoryManagement(tx, otherTenantId, 'purchase-in', query()))
    expect(foreign.rows).toHaveLength(1)
    expect(foreign.rows[0]).toMatchObject({ id: `warehouse-doc:manual-foreign-${suffix}`, supplier: '其他租户快照', amount: 888 })
  })

  it('enforces the 10k limit after combining individually bounded sources', async () => {
    const receipt = { id: 'r', warehouseId: 'w', createdById: 'u', postedAt: new Date(), no: 'R', purchaseOrder: { no: 'PO' }, supplier: { name: 'S' }, payableAmount: 1, status: 'POSTED', createdAt: new Date(), evidence: null, note: null }
    const doc = { id: 'd', warehouseId: 'w', createdById: null, effectiveAt: new Date(), docNo: 'D', supplierName: 'S', totalAmount: 1, reviewStatus: 'UNREVIEWED', createdAt: new Date(), note: null }
    const tx = {
      tenant: { findUnique: async () => ({ name: 'T', slug: 't' }) },
      upstreamReceipt: { findMany: async () => Array.from({ length: 5001 }, (_, i) => ({ ...receipt, id: `r${i}` })) },
      warehouseDoc: { findMany: async () => Array.from({ length: 5000 }, (_, i) => ({ ...doc, id: `d${i}` })) },
      warehouse: { findMany: async () => [{ id: 'w', name: 'W' }] },
      user: { findMany: async () => [] },
    }
    await expect(loadInventoryManagement(tx as never, 'tenant', 'purchase-in', query())).rejects.toMatchObject({ statusCode: 422 })
  })
})
