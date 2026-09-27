import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { warehouseStocktakeRoutes } from '../../src/routes/warehouseStocktake'
import { createWarehouseStocktake, getWarehouseStocktake, saveWarehouseStocktakePartition, transitionWarehouseStocktake } from '../../src/services/warehouseStocktake'
import { recordWarehousePhysicalCount } from '../../src/services/warehouseLedger'
import { loadInventoryManagement, managementQuerySchema } from '../../src/services/inventoryManagement'
const suffix = `ux-stocktake-${randomUUID()}`
let tenantId: string, otherTenantId: string, warehouseId: string, userId: string, secondUserId: string
let products: string[] = []
const app = Fastify()
async function create() {
  const count = await createWarehouseStocktake({ tenantId, userId, warehouseId, countDate: '2026-09-28', partitions: products.map((productId, i) => ({ name: `分区${i + 1}`, assignedToId: i ? secondUserId : userId, productIds: [productId] })) })
  return getWarehouseStocktake(tenantId, count.id)
}
async function fill(id: string, values = ['12', '8']) {
  const count = await getWarehouseStocktake(tenantId, id)
  await Promise.all(count.partitions.map((partition, i) => saveWarehouseStocktakePartition({ tenantId, userId: partition.assignedToId, id, partitionId: partition.id, version: partition.version, lines: [{ id: partition.lines[0].id, quantity: values[i], reason: '复核实盘' }] })))
}
async function cleanup(id: string) {
  await prisma.warehouseStocktakeAdjustment.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeLine.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakePartition.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktake.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId: id } })
  await prisma.opLog.deleteMany({ where: { tenantId: id } })
  await prisma.product.deleteMany({ where: { tenantId: id } })
  await prisma.user.deleteMany({ where: { tenantId: id } })
  await prisma.warehouse.deleteMany({ where: { tenantId: id } })
  await prisma.tenant.deleteMany({ where: { id } })
}
beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
  otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })).id
  warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
  const users = await Promise.all(['一', '二'].map((name, i) => prisma.user.create({ data: { tenantId, name, email: `${suffix}-${i}@test.local`, password: 'test', role: 'SUPPLY_CHAIN' } })))
  ;[userId, secondUserId] = users.map(user => user.id)
  for (let i = 0; i < 2; i++) {
    const product = await prisma.product.create({ data: { tenantId, code: `${suffix}-${i}`, name: `盘点商品${i}`, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 10 } })
    products.push(product.id)
    await recordWarehousePhysicalCount({ tenantId, userId, productId: product.id, countedInventoryQuantity: 10, countedInventoryValue: 100, effectiveAt: new Date(), idempotencyKey: randomUUID() })
  }
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: req.headers['x-tenant'] || tenantId, userId: req.headers['x-user'] || userId, role: req.headers['x-role'] || 'SUPPLY_CHAIN' } })
  await app.register(warehouseStocktakeRoutes, { prefix: '/api/warehouse-stocktakes' })
  await app.ready()
})
afterAll(async () => { await app.close(); if (tenantId) await cleanup(tenantId); if (otherTenantId) await cleanup(otherTenantId); await prisma.$disconnect() })
describe('供应链多人盘点与审核过账', () => {
  it('未盘完不能提交；多人分区独立保存、汇总；并发提交及审核只过账一次', async () => {
    const count = await create()
    await expect(transitionWarehouseStocktake(tenantId, userId, count.id, 'approve')).rejects.toMatchObject({ statusCode: 409 })
    await expect(transitionWarehouseStocktake(tenantId, userId, count.id, 'submit')).rejects.toMatchObject({ statusCode: 409 })
    await fill(count.id)
    const saved = await getWarehouseStocktake(tenantId, count.id)
    expect(saved.countedCount).toBe(2); expect(Number(saved.totalDifferenceValue)).toBe(0)
    await Promise.all(Array.from({ length: 4 }, () => transitionWarehouseStocktake(tenantId, userId, count.id, 'submit')))
    await Promise.all(Array.from({ length: 8 }, () => transitionWarehouseStocktake(tenantId, userId, count.id, 'approve')))
    const approved = await getWarehouseStocktake(tenantId, count.id)
    expect(approved.status).toBe('CONFIRMED')
    expect(approved.adjustments.map(row => row.kind).sort()).toEqual(['LOSS', 'PROFIT'])
    expect(approved.adjustments.map(row => Number(row.amount))).toEqual([20, 20])
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(2)
    for (const [i, qty] of [12, 8].entries()) {
      const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: products[i] } })
      expect(Number(balance.physicalQty)).toBe(qty)
      const lots = await prisma.warehouseLedgerLot.aggregate({ where: { tenantId, productId: products[i] }, _sum: { remainingQty: true } })
      expect(Number(lots._sum.remainingQty)).toBe(qty)
    }
    for (const page of ['count', 'multi-count', 'profit', 'loss']) {
      const list = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, page, managementQuerySchema.parse({})))
      expect(list.sourceAvailable).toBe(true); expect(list.rows.some(row => row.detailId === count.id)).toBe(true)
    }
    const review = await app.inject(`/api/warehouse-stocktakes/${count.id}/review`)
    expect(review.json().items).toHaveLength(2)
    await expect(transitionWarehouseStocktake(tenantId, userId, count.id, 'cancel')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('其他负责人不能保存分区，同分区并发保存只有一个成功，提交后不可再编辑', async () => {
    const count = await create(); const partition = count.partitions[0]
    const request = { tenantId, userId, id: count.id, partitionId: partition.id, version: 0, lines: [{ id: partition.lines[0].id, quantity: '12' }] }
    await expect(saveWarehouseStocktakePartition({ ...request, userId: secondUserId })).rejects.toMatchObject({ statusCode: 403 })
    const results = await Promise.allSettled([saveWarehouseStocktakePartition(request), saveWarehouseStocktakePartition(request)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    await fill(count.id)
    await transitionWarehouseStocktake(tenantId, userId, count.id, 'submit')
    await expect(saveWarehouseStocktakePartition({ ...request, version: 1 })).rejects.toMatchObject({ statusCode: 409 })
    await transitionWarehouseStocktake(tenantId, userId, count.id, 'reject')
    expect((await getWarehouseStocktake(tenantId, count.id)).status).toBe('COUNTING')
  })
  it('盘点期间库存变化时整单审核回滚，不覆盖库存、不留下盘盈亏单', async () => {
    const count = await create(); await fill(count.id)
    await transitionWarehouseStocktake(tenantId, userId, count.id, 'submit')
    await recordWarehousePhysicalCount({ tenantId, userId, productId: products[1], countedInventoryQuantity: 15, countedInventoryValue: 150, effectiveAt: new Date(), idempotencyKey: randomUUID() })
    await expect(transitionWarehouseStocktake(tenantId, userId, count.id, 'approve')).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseStocktakeAdjustment.count({ where: { stocktakeId: count.id } })).toBe(0)
    expect(await prisma.warehouseLedgerMovement.count({ where: { sourceId: count.id } })).toBe(0)
    expect((await getWarehouseStocktake(tenantId, count.id)).status).toBe('REVIEWING')
  })
  it('API 与数据库租户隔离，审核角色沿用仓库单据口径', async () => {
    const count = await create()
    expect((await app.inject({ url: `/api/warehouse-stocktakes/${count.id}`, headers: { 'x-tenant': otherTenantId } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/submit`, headers: { 'x-tenant': otherTenantId } })).statusCode).toBe(404)
    for (const role of ['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'KITCHEN_LEAD', 'MANAGER', 'BOSS']) expect((await app.inject({ url: '/api/warehouse-stocktakes', headers: { 'x-role': role } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/approve`, headers: { 'x-role': 'PURCHASER' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes', headers: { 'x-role': 'FINANCE' }, payload: {} })).statusCode).toBe(403)
    await expect(createWarehouseStocktake({ tenantId: otherTenantId, userId, warehouseId, countDate: '2026-09-28', partitions: [{ name: '跨租户', assignedToId: userId, productIds: products }] })).rejects.toMatchObject({ statusCode: 404 })
    await expect(prisma.warehouseStocktake.create({ data: { tenantId: otherTenantId, warehouseId, no: suffix, countDate: new Date(), createdById: userId } })).rejects.toMatchObject({ code: 'P2003' })
  })
  it('完整 API 路径：创建→逐人保存→提交→FINANCE 审核→复盘与盘盈亏结果', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes', payload: { warehouseId, countDate: '2026-09-28', tenantId: otherTenantId, partitions: products.map((productId, i) => ({ name: `API分区${i}`, assignedToId: i ? secondUserId : userId, productIds: [productId] })) } })
    expect(response.statusCode).toBe(201)
    const id = response.json().id
    const detail = (await app.inject(`/api/warehouse-stocktakes/${id}`)).json()
    expect(detail.tenantId).toBe(tenantId)
    for (const [i, partition] of detail.partitions.entries()) {
      const result = await app.inject({ method: 'PUT', url: `/api/warehouse-stocktakes/${id}/partitions/${partition.id}`, headers: { 'x-user': partition.assignedToId }, payload: { version: 0, lines: [{ id: partition.lines[0].id, quantity: i ? '14' : '13' }] } })
      expect(result.statusCode).toBe(200)
    }
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${id}/submit` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${id}/approve`, headers: { 'x-role': 'FINANCE' } })).statusCode).toBe(200)
    const approved = (await app.inject(`/api/warehouse-stocktakes/${id}`)).json()
    expect(approved.status).toBe('CONFIRMED'); expect(approved.adjustments).toHaveLength(2)
  })

})
