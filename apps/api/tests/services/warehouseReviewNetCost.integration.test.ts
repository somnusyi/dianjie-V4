import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import ExcelJS from 'exceljs'
import { inventoryReportRoutes } from '../../src/routes/inventoryReports'
import { postReceiptBusinessInTransaction } from '../../src/routes/upstreamProcurement'
import { changeProcurementApproval, type ProcurementSourceKind } from '../../src/services/procurementApproval'
import { createUpstreamPurchaseReturn, submitUpstreamPurchaseReturnInTransaction, postUpstreamPurchaseReturnBusinessInTransaction } from '../../src/services/upstreamPurchaseReturns'
import { createReviewInbound, createReviewOutbound } from '../../src/services/warehouseReviewPosting'
import { confirmWarehouseDoc, reviewWarehouseDoc } from '../../src/services/warehouseDocs'
import { serializableWithRetry } from '../../src/services/warehouseLedger'
import { createWarehouseStocktake, getWarehouseStocktake, saveWarehouseStocktakeSection, submitWarehouseStocktake, approveWarehouseStocktake, reviewWarehouseStocktake } from '../../src/services/warehouseStocktake'

// This test creates only synthetic tenants in the existing dedicated test DB.
// Never use the normal application .env or the integration DB prepare/reset script.
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/')
if (database.hostname !== '127.0.0.1' || database.port !== '15449' || database.pathname !== '/dianjie_four_gap_test') {
  throw new Error('Dedicated synthetic database 127.0.0.1:15449/dianjie_four_gap_test required')
}
let tenantId: string, warehouseId: string, supplierId: string, productId: string, actorA: string, actorB: string
let app: ReturnType<typeof Fastify>
const at = new Date('2026-11-03T08:00:00Z')
const common = () => ({ tenantId, warehouseId, userId: actorA, effectiveAt: at })
const balance = () => prisma.warehouseLedgerBalance.findFirst({ where: { tenantId, warehouseId, productId } })
async function ledgerSnapshot() {
  return JSON.stringify({
    balance: await balance(),
    movements: await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, productId }, orderBy: { id: 'asc' } }),
    lots: await prisma.warehouseLedgerLot.findMany({ where: { tenantId, productId }, orderBy: { id: 'asc' } }),
  })
}
beforeEach(async () => {
  tenantId = (await prisma.tenant.create({ data: { slug: `review-net-${randomUUID()}`, name: '山禾供应链业务演练' } })).id
  warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
  await prisma.warehouse.update({ where: { id: warehouseId }, data: { inventoryMode: 'STRICT' } })
  supplierId = (await prisma.supplier.create({ data: { tenantId, no: 'SH01', name: '山禾食材', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
  for (const key of ['A', 'B']) {
    const user = await prisma.user.create({ data: { tenantId, email: `${key}-${randomUUID()}@local.invalid`, name: `供应链${key}`, role: 'SUPPLY_CHAIN', password: 'disabled-synthetic-account' } })
    if (key === 'A') actorA = user.id
    else actorB = user.id
  }
  productId = (await prisma.product.create({ data: { tenantId, code: 'SH-001', name: '香菇', unit: 'kg', purchaseUnit: '袋', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 5, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 5 } })).id
  app = Fastify()
  await app.register(jwt, { secret: 'local-review-net-synthetic-only' })
  app.decorate('authenticate', async (req: any) => { await req.jwtVerify() })
  await app.register(inventoryReportRoutes, { prefix: '/api/inventory-reports' })
  await app.ready()
})
afterEach(async () => { await app?.close() })
// Unique synthetic tenants are deliberately retained for local accounting inspection.
afterAll(async () => { await prisma.$disconnect() })

async function report(id: string, exportFile = false) {
  const response = await app.inject({ url: `/api/inventory-reports/${id}?start=2026-01-01&end=2026-12-31&warehouseId=${warehouseId}${exportFile ? '&export=1' : ''}`, headers: { authorization: `Bearer ${app.jwt.sign({ tenantId, userId: actorA, role: 'SUPPLY_CHAIN' })}` } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function assertExcelCells(kind: string, values: Record<string, unknown>) {
  const data = await report(kind)
  expect(data.rows).toHaveLength(1)
  expect(data.rows[0]).toMatchObject(values)
  const exported = await report(kind, true), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
  for (const [field, value] of Object.entries(values)) {
    const index = data.columns.findIndex((column: any) => column.key === field)
    if (index < 0) continue // costStatus is metadata, not a visible export column.
    expect(workbook.worksheets[0].getRow(2).getCell(index + 1).value, `${kind}.${field}`).toBe(value == null && /Amount|Price|amount|price/.test(field) ? '待核算' : value)
  }
}
async function procurementRequest(kind: ProcurementSourceKind, id: string, action: 'submit' | 'audit' | 'review', userId = actorA) {
  const row = kind === 'RECEIPT' ? await prisma.upstreamReceipt.findUniqueOrThrow({ where: { id } }) : await prisma.upstreamPurchaseReturn.findUniqueOrThrow({ where: { id } })
  return { tenantId, userId, kind, sourceId: id, action, approvalVersion: row.approvalVersion, sourceVersion: row.rowVersion, requestId: randomUUID() }
}
const receiptHooks = () => ({ review: async (tx: any, source: any) => {
  const result = await postReceiptBusinessInTransaction(tx, tenantId, 'SUPPLY_CHAIN', actorB, source.id, true, {}, true)
  if (!result || result.pendingReview) throw Error('Receipt was not posted')
  return result
} })
async function newSplitPurchase() {
  // Schema defaults freeze taxInclusive=true and line taxRate=0. Do not assign a
  // made-up customer tax rate, or change an existing contract to manufacture cost.
  const order = await prisma.upstreamPurchaseOrder.create({ data: { tenantId, no: `CG-${randomUUID()}`, supplierId, warehouseId, createdById: actorA, status: 'SUPPLIER_ACCEPTED', amountWithoutTax: 250, taxAmount: 0, totalAmount: 250, lines: { create: { lineNo: 1, productId, productCodeSnapshot: 'SH-001', productNameSnapshot: '香菇', purchaseUnit: '袋', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 5, orderedQty: 10, confirmedQty: 10, unitPrice: 25, amountWithoutTax: 250, taxAmount: 0, totalAmount: 250 } } }, include: { lines: true } })
  expect(order.taxInclusive).toBe(true)
  expect(order.lines[0].taxRate.toString()).toBe('0')
  const receipts = []
  for (let n = 0; n < 2; n++) receipts.push(await prisma.upstreamReceipt.create({ data: { tenantId, no: `RK-${randomUUID()}`, purchaseOrderId: order.id, supplierId, warehouseId, createdById: actorA, status: 'DRAFT', arrivedAt: at, payableAmount: 125, lines: { create: { purchaseOrderLineId: order.lines[0].id, productId, orderedQty: 5, arrivedQty: 5, acceptedQty: 5, purchaseUnit: '袋', inventoryUnit: 'kg', inventoryUnitsPerPurchaseUnit: 5, inventoryAcceptedQty: 25, unitPrice: 25, payableAmount: 125 } } }, include: { lines: true } }))
  return receipts
}
async function finishReceipt(receiptId: string) {
  const before = await ledgerSnapshot()
  await changeProcurementApproval(await procurementRequest('RECEIPT', receiptId, 'submit'))
  await changeProcurementApproval(await procurementRequest('RECEIPT', receiptId, 'audit'))
  expect(await ledgerSnapshot()).toBe(before)
  await expect(changeProcurementApproval(await procurementRequest('RECEIPT', receiptId, 'review'), receiptHooks())).rejects.toMatchObject({ statusCode: 403 })
  const request = await procurementRequest('RECEIPT', receiptId, 'review', actorB)
  await changeProcurementApproval(request, receiptHooks())
  const after = await ledgerSnapshot()
  expect((await changeProcurementApproval(request, receiptHooks())).replayed).toBe(true)
  expect(await ledgerSnapshot()).toBe(after)
}
async function seedKnownPool() { const receipts = await newSplitPurchase(); for (const receipt of receipts) await finishReceipt(receipt.id); return receipts }

it('two receipt reviews establish frozen-source net cost; return review changes every report and export only once', async () => {
  const receipts = await seedKnownPool()
  await assertExcelCells('realtime', { qty: 50, amount: 250, price: 5, costStatus: 'KNOWN' })
  const ret = (await createUpstreamPurchaseReturn({ tenantId, userId: actorA, supplierId, warehouseId, reason: '本批退回', idempotencyKey: randomUUID(), lines: [{ receiptLineId: receipts[0].lines[0].id, purchaseQuantity: 1 }] })).purchaseReturn
  const hooks = { submit: (tx: any, source: any) => submitUpstreamPurchaseReturnInTransaction(tx, tenantId, source.id, actorA), review: (tx: any, source: any) => postUpstreamPurchaseReturnBusinessInTransaction(tx, tenantId, source.id, actorB) }
  const before = await ledgerSnapshot()
  await changeProcurementApproval(await procurementRequest('RETURN', ret.id, 'submit'), hooks)
  await changeProcurementApproval(await procurementRequest('RETURN', ret.id, 'audit'), hooks)
  expect(await ledgerSnapshot()).toBe(before)
  const request = await procurementRequest('RETURN', ret.id, 'review', actorB)
  await changeProcurementApproval(request, hooks)
  const posted = await ledgerSnapshot()
  expect((await changeProcurementApproval(request, hooks)).replayed).toBe(true)
  expect(await ledgerSnapshot()).toBe(posted)
  await assertExcelCells('realtime', { qty: 45, amount: 225, price: 5, costStatus: 'KNOWN' })
  await assertExcelCells('summary', { openingQty: 0, openingAmount: 0, inQty: 50, inAmount: 250, outQty: 5, outAmount: 25, closingQty: 45, closingAmount: 225, closingPrice: 5 })
  const detail = await report('movements')
  expect(detail.rows.filter((row: any) => row.type === '采购入库')).toHaveLength(2)
  expect(detail.rows.find((row: any) => row.type === '采购退货')).toMatchObject({ outAmount: 25, outPrice: 25 }) // one 袋 = 5kg
  const workbook = new ExcelJS.Workbook(), exported = await report('movements', true)
  await workbook.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
  const column = detail.columns.findIndex((entry: any) => entry.key === 'outAmount') + 1
  expect(workbook.worksheets[0].getColumn(column).values).toContain(25)
})

it('reviewed manual inbound appears only after review and stays pending without documented net basis', async () => {
  const key = randomUUID(), doc = (await serializableWithRetry(tx => createReviewInbound(tx, { ...common(), supplierId, idempotencyKey: key, documentKey: `inbound-draft:${key}`, items: [{ productId, purchaseQuantity: 2, totalAmount: 50 }] }))).doc
  const before = await ledgerSnapshot()
  await confirmWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })
  expect(await ledgerSnapshot()).toBe(before)
  expect((await report('movements')).rows).toHaveLength(0)
  await reviewWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })
  const posted = await ledgerSnapshot()
  expect((await reviewWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })).changed).toBe(false)
  expect(await ledgerSnapshot()).toBe(posted)
  expect((await balance())!.inventoryValue.toString()).toBe('50')
  await assertExcelCells('realtime', { qty: 10, amount: null, price: null, costStatus: 'PENDING_COST' })
})

async function reviewedCount(delta: number) {
  const current = await balance(), created = await createWarehouseStocktake({ tenantId, userId: actorA, warehouseId, countDate: '2026-11-03', requestKey: randomUUID(), sections: [{ name: '总仓', assignedToId: actorA, productIds: [productId] }] })
  let count = await getWarehouseStocktake(tenantId, created.stocktake.id)
  const section = count.sections[0]
  await saveWarehouseStocktakeSection({ tenantId, userId: actorA, stocktakeId: count.id, sectionId: section.id, rowVersion: section.rowVersion, submit: true, items: [{ itemId: section.items[0].id, countedQuantity: current!.physicalQty.plus(delta).toString(), reason: '核实盘点差异' }] })
  count = await getWarehouseStocktake(tenantId, count.id)
  await submitWarehouseStocktake({ tenantId, userId: actorA, id: count.id, rowVersion: count.rowVersion })
  const before = await ledgerSnapshot()
  await approveWarehouseStocktake({ tenantId, userId: actorA, id: count.id })
  expect(await ledgerSnapshot()).toBe(before)
  await reviewWarehouseStocktake({ tenantId, userId: actorA, id: count.id })
  const after = await ledgerSnapshot()
  expect((await reviewWarehouseStocktake({ tenantId, userId: actorA, id: count.id })).replayed).toBe(true)
  expect(await ledgerSnapshot()).toBe(after)
}

it('manual outbound and count loss inherit known pool net cost only at review', async () => {
  await seedKnownPool()
  const key = randomUUID(), doc = (await serializableWithRetry(tx => createReviewOutbound(tx, { ...common(), idempotencyKey: key, documentKey: `manual-outbound:${key}`, reason: '领用', items: [{ productId, inventoryQuantity: 5 }] }))).doc
  const before = await ledgerSnapshot()
  await confirmWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })
  expect(await ledgerSnapshot()).toBe(before)
  await reviewWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })
  const posted = await ledgerSnapshot()
  expect((await reviewWarehouseDoc({ tenantId, userId: actorA, docId: doc.id })).changed).toBe(false)
  expect(await ledgerSnapshot()).toBe(posted)
  await assertExcelCells('realtime', { qty: 45, amount: 225, price: 5, costStatus: 'KNOWN' })
  await reviewedCount(-1)
  await assertExcelCells('realtime', { qty: 44, amount: 220, price: 5, costStatus: 'KNOWN' })
  await assertExcelCells('summary', { inQty: 50, inAmount: 250, outQty: 6, outAmount: 30, closingQty: 44, closingAmount: 220, closingPrice: 5 })
  const detail = await report('movements')
  expect(detail.rows.find((row: any) => row.type === '报损')).toMatchObject({ outAmount: 5, outPrice: 5 })
})

it('count profit does not invent a tax-exclusive cost basis for newly found stock', async () => {
  await seedKnownPool()
  await assertExcelCells('realtime', { qty: 50, amount: 250, price: 5, costStatus: 'KNOWN' })
  await reviewedCount(1)
  expect((await balance())!.inventoryValue.toString()).toBe('255')
  await assertExcelCells('realtime', { qty: 51, amount: null, price: null, costStatus: 'PENDING_COST' })
  await assertExcelCells('summary', { closingQty: 51, closingAmount: null, closingPrice: null })
})
