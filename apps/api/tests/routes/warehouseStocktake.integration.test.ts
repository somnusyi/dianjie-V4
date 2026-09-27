import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { warehouseStocktakeRoutes } from '../../src/routes/warehouseStocktake'
import {
  approveWarehouseStocktake,
  cancelWarehouseStocktake,
  createWarehouseStocktake,
  getWarehouseStocktake,
  rejectWarehouseStocktake,
  saveWarehouseStocktakeSection,
  submitWarehouseStocktake,
} from '../../src/services/warehouseStocktake'
import { recordWarehousePhysicalCount } from '../../src/services/warehouseLedger'

const suffix = `warehouse-stocktake-${randomUUID()}`
let tenantId = ''
let otherTenantId = ''
let warehouseId = ''
let userId = ''
let secondUserId = ''
let productIds: string[] = []
const app = Fastify()

async function createCount() {
  const result = await createWarehouseStocktake({
    tenantId, userId, warehouseId, countDate: '2026-09-28', requestKey: randomUUID(),
    sections: productIds.map((productId, index) => ({ name: `分区${index + 1}`, assignedToId: index ? secondUserId : userId, productIds: [productId] })),
  })
  return result.stocktake
}

async function fillAndSubmitSections(id: string, quantities: string[]) {
  let count = await getWarehouseStocktake(tenantId, id)
  await Promise.all(count.sections.map((section, index) => saveWarehouseStocktakeSection({
    tenantId, userId: section.assignedToId, stocktakeId: id, sectionId: section.id, rowVersion: section.rowVersion, submit: true,
    items: [{ itemId: section.items[0].id, countedQuantity: quantities[index], reason: quantities[index] === '10' ? null : '复核实盘' }],
  })))
  count = await getWarehouseStocktake(tenantId, id)
  return submitWarehouseStocktake({ tenantId, userId, id, rowVersion: count.rowVersion })
}

async function cleanup(id: string) {
  await prisma.warehouseStocktakeAdjustmentLine.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeAdjustment.deleteMany({ where: { tenantId: id } })
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
  const users = await Promise.all(['盘点员一', '盘点员二'].map((name, index) => prisma.user.create({
    data: { tenantId, name, email: `${suffix}-${index}@test.local`, password: 'test', role: 'SUPPLY_CHAIN' },
  })))
  ;[userId, secondUserId] = users.map(user => user.id)
  for (let index = 0; index < 2; index += 1) {
    const product = await prisma.product.create({ data: {
      tenantId, code: `${suffix}-${index}`, name: `盘点商品${index}`, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 10,
    } })
    productIds.push(product.id)
    await recordWarehousePhysicalCount({ tenantId, userId, productId: product.id, countedInventoryQuantity: 10, countedInventoryValue: 100, effectiveAt: new Date(), idempotencyKey: randomUUID() })
  }
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: req.headers['x-tenant'] || tenantId, userId: req.headers['x-user'] || userId, role: req.headers['x-role'] || 'SUPPLY_CHAIN' } })
  await app.register(warehouseStocktakeRoutes, { prefix: '/api/warehouse-stocktakes' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  if (tenantId) await cleanup(tenantId)
  if (otherTenantId) await cleanup(otherTenantId)
  await prisma.$disconnect()
})

describe('总仓多人分区盘点', () => {
  it('创建请求持久幂等，同仓只允许一张活动盘点单', async () => {
    const requestKey = randomUUID()
    const input = { tenantId, userId, warehouseId, countDate: '2026-09-28', requestKey, sections: [{ name: '全仓', assignedToId: userId, productIds }] }
    const first = await createWarehouseStocktake(input)
    const replay = await createWarehouseStocktake(input)
    expect(replay.replayed).toBe(true)
    expect(replay.stocktake.id).toBe(first.stocktake.id)
    await expect(createWarehouseStocktake({ ...input, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 })
    await expect(createWarehouseStocktake({ ...input, sections: [{ ...input.sections[0], name: '另一个分区' }] })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: first.stocktake.id, rowVersion: first.stocktake.rowVersion, reason: '幂等测试结束' })
  })

  it('逐人提交后汇总审核，只按差额过账且并发审核幂等', async () => {
    const count = await createCount()
    await fillAndSubmitSections(count.id, ['12', '8'])
    const approvals = await Promise.all(Array.from({ length: 4 }, () => approveWarehouseStocktake({ tenantId, userId, id: count.id })))
    expect(approvals.filter(row => !row.replayed)).toHaveLength(1)
    const approved = await getWarehouseStocktake(tenantId, count.id)
    expect(approved.status).toBe('CONFIRMED')
    expect(approved.adjustments.map(row => row.type).sort()).toEqual(['LOSS', 'PROFIT'])
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(2)
    for (const [index, quantity] of [12, 8].entries()) {
      const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: productIds[index] } })
      expect(Number(balance.physicalQty)).toBe(quantity)
      const lots = await prisma.warehouseLedgerLot.aggregate({ where: { tenantId, productId: productIds[index] }, _sum: { remainingQty: true } })
      expect(Number(lots._sum.remainingQty)).toBe(quantity)
    }
  })

  it('零差异不生成流水、调整单或重建批次', async () => {
    const beforeLots = await prisma.warehouseLedgerLot.findMany({ where: { tenantId }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    const count = await createCount()
    await fillAndSubmitSections(count.id, ['12', '8'])
    // 当前账面已是 12/8，因此本单全部零差异。
    await approveWarehouseStocktake({ tenantId, userId, id: count.id })
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(0)
    expect(await prisma.warehouseStocktakeAdjustment.count({ where: { stocktakeId: count.id } })).toBe(0)
    const afterLots = await prisma.warehouseLedgerLot.findMany({ where: { tenantId }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    expect(afterLots).toEqual(beforeLots)
  })

  it('同分区旧版本覆盖被拒绝，已提交分区不可继续编辑', async () => {
    const count = await createCount()
    const section = count.sections[0]
    const request = { tenantId, userId, stocktakeId: count.id, sectionId: section.id, rowVersion: section.rowVersion, submit: false, items: [{ itemId: section.items[0].id, countedQuantity: '12', reason: '复核' }] }
    await expect(saveWarehouseStocktakeSection({ ...request, userId: secondUserId })).rejects.toMatchObject({ statusCode: 403 })
    const results = await Promise.allSettled([saveWarehouseStocktakeSection(request), saveWarehouseStocktakeSection(request)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    let detail = await getWarehouseStocktake(tenantId, count.id)
    const updatedSection = detail.sections.find(row => row.id === section.id)!
    await saveWarehouseStocktakeSection({ ...request, rowVersion: updatedSection.rowVersion, submit: true })
    detail = await getWarehouseStocktake(tenantId, count.id)
    await expect(saveWarehouseStocktakeSection({ ...request, rowVersion: detail.sections.find(row => row.id === section.id)!.rowVersion })).rejects.toMatchObject({ statusCode: 409 })
    await expect(cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: count.rowVersion, reason: '陈旧页面取消' })).rejects.toMatchObject({ statusCode: 409 })
    detail = await getWarehouseStocktake(tenantId, count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: detail.rowVersion, reason: '测试结束释放活动单' })
  })

  it('盘点期间库存变动时整单回滚，不覆盖新出入库', async () => {
    const count = await createCount()
    await fillAndSubmitSections(count.id, ['13', '7'])
    await recordWarehousePhysicalCount({ tenantId, userId, productId: productIds[1], countedInventoryQuantity: 9, countedInventoryValue: 90, effectiveAt: new Date(), idempotencyKey: randomUUID() })
    await expect(approveWarehouseStocktake({ tenantId, userId, id: count.id })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseStocktakeAdjustment.count({ where: { stocktakeId: count.id } })).toBe(0)
    expect(await prisma.warehouseLedgerMovement.count({ where: { sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(0)
    expect((await getWarehouseStocktake(tenantId, count.id)).status).toBe('REVIEWING')
    await rejectWarehouseStocktake({ tenantId, userId, id: count.id, reason: '库存已变动' })
    const rejected = await getWarehouseStocktake(tenantId, count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: rejected.rowVersion, reason: '重新发起盘点' })
  })

  it('API 租户隔离、权限及无反审核路由', async () => {
    const count = await createCount()
    expect((await app.inject({ url: `/api/warehouse-stocktakes/${count.id}`, headers: { 'x-tenant': otherTenantId } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/approve`, headers: { 'x-role': 'PURCHASER' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes', headers: { 'x-role': 'FINANCE' }, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/reverse` })).statusCode).toBe(404)
    await expect(createWarehouseStocktake({ tenantId: otherTenantId, userId, warehouseId, countDate: '2026-09-28', requestKey: randomUUID(), sections: [{ name: '跨租户', assignedToId: userId, productIds }] })).rejects.toMatchObject({ statusCode: 404 })
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: count.rowVersion, reason: '权限测试结束' })
  })
})
