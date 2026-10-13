import { prisma } from '@dianjie/db'
import Fastify from 'fastify'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { ensureWarehouseDoc, confirmWarehouseDoc, reviewWarehouseDoc, unreviewWarehouseDoc } from '../../src/services/warehouseDocs'
import { recordBatchManualWarehouseInbound } from '../../src/services/warehouseLedger'
import { warehouseDocsRoutes } from '../../src/routes/warehouseDocs'
vi.mock('../../src/routes/upload', () => ({ signOssKey: (key: string) => `https://fixture.invalid/${key}`, assertWarehouseDocumentObjects: vi.fn().mockResolvedValue(undefined) }))
let tenantId: string, userId: string, supplierId: string, productId: string, warehouseId: string, docId: string
const app = Fastify()
beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { slug: `dj024-review-${Date.now()}`, name: 'DJ024独立复审测试' } })).id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'REVIEW', name: '复审测试仓', isDefault: true, inventoryMode: 'SHADOW' } })).id
  userId = (await prisma.user.create({ data: { tenantId, email: 'review@local.invalid', name: '供应链复审夹具', role: 'SUPPLY_CHAIN', password: 'unusable-fixture' } })).id
  supplierId = (await prisma.supplier.create({ data: { tenantId, no: 'SUP001', name: '复审测试上游', status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'] } })).id
  productId = (await prisma.product.create({ data: { tenantId, code: 'REVIEW001', name: '复审测试商品', price: 2, unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' } })).id
  const movement = await recordBatchManualWarehouseInbound({ tenantId, userId, supplierId, effectiveAt: new Date(), idempotencyKey: 'review-fixture', items: [{ productId, purchaseQuantity: 2, totalAmount: 4 }] })
  docId = (await ensureWarehouseDoc({ tenantId, userId, supplierId, warehouseId, type: 'MANUAL_INBOUND', effectiveAt: new Date(), idempotencyKey: 'review-fixture-doc', lines: [{ productId, productName: '复审测试商品', quantity: 2, unit: 'kg', unitPrice: 2, amount: 4, inventoryQuantity: 2, inventoryUnit: 'kg', movementId: movement.movements[0].id }] })).doc.id
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId, userId, role: req.headers['x-role'] || 'SUPPLY_CHAIN' } })
  await app.register(warehouseDocsRoutes, { prefix: '/docs' }); await app.ready()
})
afterAll(async () => { await app.close(); await prisma.$disconnect() })
const input = () => ({ tenantId, userId, docId })
async function stock() {
  return JSON.stringify({ balances: await prisma.warehouseLedgerBalance.findMany({ where: { tenantId, productId } }), lots: await prisma.warehouseLedgerLot.findMany({ where: { tenantId, productId } }), movements: await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, productId } }) })
}
it('rejects review/cancel review before audit and cross-tenant lookups without changing stock', async () => {
  const before = await stock()
  await expect(reviewWarehouseDoc(input())).rejects.toThrow('先完成')
  await expect(unreviewWarehouseDoc(input())).rejects.toThrow('不支持取消复审')
  await expect(unreviewWarehouseDoc({ ...input(), tenantId: 'other-tenant' })).rejects.toThrow('单据不存在')
  expect(await stock()).toBe(before)
})
it('concurrent final review logs once, cancellation is rejected and inventory stays unchanged', async () => {
  await confirmWarehouseDoc(input()); const before = await stock()
  const reviewed = await Promise.all([reviewWarehouseDoc(input()), reviewWarehouseDoc(input())])
  expect(reviewed.filter(result => result.changed)).toHaveLength(1)
  expect(await prisma.warehouseDocLog.count({ where: { docId, action: 'REVIEW' } })).toBe(1)
  expect(await stock()).toBe(before)
  for(const operation of [unreviewWarehouseDoc,unreviewWarehouseDoc])await expect(operation(input())).rejects.toMatchObject({statusCode:409})
  expect(await prisma.warehouseDocLog.count({where:{docId,action:'UNREVIEW'}})).toBe(0)
  expect((await prisma.warehouseDoc.findUniqueOrThrow({ where: { id: docId } })).status).toBe('CONFIRMED')
  expect(await stock()).toBe(before)
})
it('finance cannot review, cancel review, audit or unaudit inventory documents', async () => {
  const before = await stock()
  for (const operation of ['review', 'unreview', 'confirm', 'unconfirm']) {
    const response = await app.inject({ method: 'POST', url: `/docs/${docId}/${operation}`, headers: { 'x-role': 'FINANCE' }, payload: { reason: '隔离权限验证' } })
    expect(response.statusCode).toBe(403)
  }
  expect(await stock()).toBe(before)
})
it('legacy supply-chain cancellation route is rejected', async () => {
  const response = await app.inject({ method: 'POST', url: `/docs/${docId}/unreview`, payload: {} })
  expect(response.statusCode).toBe(409); expect(response.json().error).toContain('不支持取消复审')
})

it('document editor descriptions retain document snapshots and scope warehouse/products to its tenant', async () => {
  const response = await app.inject({ method: 'GET', url: `/docs/${docId}` })
  expect(response.statusCode).toBe(200)
  const detail = response.json()
  expect(detail.organizationName).toBe('DJ024独立复审测试')
  expect(detail.warehouse).toEqual({ id: warehouseId, code: 'REVIEW', name: '复审测试仓' })
  expect(detail.lines[0]).toMatchObject({ productCode: 'REVIEW001', productName: '复审测试商品', unit: 'kg' })
  expect(detail.lines[0].productCategory).toBe('其他')
  expect(detail.lines[0].productSpec).toBeNull()
})
