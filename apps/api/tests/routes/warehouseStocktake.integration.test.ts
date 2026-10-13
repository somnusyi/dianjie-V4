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
  refreshWarehouseStocktakeUnits,
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
  const testDb = new URL(process.env.DATABASE_URL || '')
  if (testDb.hostname !== '127.0.0.1' || testDb.port !== '15439' || testDb.pathname !== '/dianjie_mouse_test') throw new Error('此测试仅限本轮隔离合成数据库')
  tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
  otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })).id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'TEST-DEFAULT', name: '测试总仓', isDefault: true, inventoryMode: 'SHADOW' } })).id
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
  it('全部范围由服务器核对，漏项拒绝，双人分区不丢负责人', async () => {
    const input = { tenantId, userId, warehouseId, countScope: 'ALL' as const, countDate: '2026-10-10', requestKey: randomUUID(), sections: [{ name: '一', assignedToId: userId, productIds: [productIds[0]] }] }
    await expect(createWarehouseStocktake(input)).rejects.toMatchObject({ statusCode: 400 })
    const result = await createWarehouseStocktake({ ...input, sections: [...input.sections, { name: '二', assignedToId: secondUserId, productIds: [productIds[1]] }] })
    expect(result.stocktake.sections.map(section => section.assignedToId).sort()).toEqual([userId, secondUserId].sort())
    expect(result.stocktake.itemCount).toBe(2)
    expect(result.stocktake.countScope).toBe('ALL')
    await cancelWarehouseStocktake({ tenantId, userId, id: result.stocktake.id, rowVersion: result.stocktake.rowVersion, reason: '全量分区验收结束' })
  })

  it('缺换算商品保留在服务器草稿，阻止录入提交；人工核验后刷新可恢复', async () => {
    const product = await prisma.product.create({ data: { tenantId, code: `${suffix}-PENDING`, name: '待补换算', unit: 'kg', inventoryUnit: 'kg', unitConversionStatus: 'PENDING', price: 10 } })
    const input = { tenantId, userId, warehouseId, countScope: 'ALL' as const, countDate: '2026-10-10', requestKey: randomUUID(), sections: [{ name: '完整范围', assignedToId: userId, productIds: [...productIds, product.id] }] }
    const count = (await createWarehouseStocktake(input)).stocktake
    const item = count.sections[0].items.find(item => item.productId === product.id)!
    expect(item.unitPending).toBe(true)
    expect(count.itemCount).toBe(3)
    expect(await prisma.warehouseLedgerBalance.count({ where: { tenantId, productId: product.id } })).toBe(0)
    await expect(saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: count.id, sectionId: count.sections[0].id, rowVersion: 0, submit: true, items: [{ itemId: item.id, countedQuantity: '0' }] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(refreshWarehouseStocktakeUnits({ tenantId, id: count.id, rowVersion: count.rowVersion })).rejects.toMatchObject({ statusCode: 400 })
    await prisma.product.update({ where: { id: product.id }, data: { purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' } })
    const refreshed = await refreshWarehouseStocktakeUnits({ tenantId, id: count.id, rowVersion: count.rowVersion })
    expect(refreshed.sections[0].items.find(row => row.productId === product.id)?.unitPending).toBe(false)
    const replay = await createWarehouseStocktake(input)
    expect(replay.replayed).toBe(true)
    expect(replay.stocktake.id).toBe(count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: refreshed.rowVersion, reason: '缺换算草稿验收结束' })
    await prisma.product.update({ where: { id: product.id }, data: { status: 'DISABLED' } })
  })
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
    const concurrent = await Promise.allSettled([0, 1].map(() => createWarehouseStocktake({ ...input, requestKey: randomUUID() })))
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = concurrent.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof createWarehouseStocktake>>>
    await cancelWarehouseStocktake({ tenantId, userId, id: winner.value.stocktake.id, rowVersion: winner.value.stocktake.rowVersion, reason: '并发创建验收结束' })
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

  it('缺差异原因可以保存草稿但不能锁定分区，拒绝提交整笔回滚且可补原因重试', async () => {
    const count = await createCount()
    const section = count.sections[0]
    const item = section.items[0]
    const quantity = item.bookQuantity.plus(1).toString()
    const base = { tenantId, userId, stocktakeId: count.id, sectionId: section.id, rowVersion: section.rowVersion, items: [{ itemId: item.id, countedQuantity: quantity, reason: '' }] }
    await saveWarehouseStocktakeSection({ ...base, submit: false })
    const saved = await getWarehouseStocktake(tenantId, count.id)
    const current = saved.sections.find(row => row.id === section.id)!
    const ledgerBefore = await prisma.warehouseLedgerMovement.count({ where: { tenantId } })
    await expect(saveWarehouseStocktakeSection({ ...base, rowVersion: current.rowVersion, submit: true })).rejects.toMatchObject({ statusCode: 400 })
    expect(await getWarehouseStocktake(tenantId, count.id)).toEqual(saved)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId } })).toBe(ledgerBefore)
    const entry = await prisma.warehouseStocktakeEntry.findUniqueOrThrow({ where: { stocktakeItemId: item.id } })
    expect(entry.rowVersion).toBe(0)
    expect(current.status).toBe('OPEN')
    await saveWarehouseStocktakeSection({ ...base, rowVersion: current.rowVersion, submit: true, items: [{ itemId: item.id, countedQuantity: quantity, reason: '差异实盘复核' }] })
    const after = await getWarehouseStocktake(tenantId, count.id)
    expect(after.sections.find(row => row.id === section.id)!.status).toBe('SUBMITTED')
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: after.rowVersion, reason: '测试结束保留修复边界' })
  })

  it('提交只含另一项也检查已保存缺原因项，空白原因及试改字段整笔回滚', async () => {
    const result = await createWarehouseStocktake({ tenantId, userId, warehouseId, countDate: '2026-09-28', requestKey: randomUUID(), sections: [{ name: '完整分区校验', assignedToId: userId, productIds }] })
    const count = result.stocktake, section = count.sections[0], first = section.items[0], second = section.items[1]
    await saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: count.id, sectionId: section.id, rowVersion: section.rowVersion, submit: false, items: [{ itemId: first.id, countedQuantity: first.bookQuantity.plus(1).toString(), reason: '   ' }] })
    const saved = await getWarehouseStocktake(tenantId, count.id), current = saved.sections[0]
    const request = { tenantId, userId, stocktakeId: count.id, sectionId: section.id, rowVersion: current.rowVersion, submit: true }
    await expect(saveWarehouseStocktakeSection({ ...request, items: [{ itemId: second.id, countedQuantity: second.bookQuantity.toString(), reason: '本次其他项' }] })).rejects.toMatchObject({ statusCode: 400 })
    expect(await getWarehouseStocktake(tenantId, count.id)).toEqual(saved)
    expect(await prisma.warehouseStocktakeEntry.findUnique({ where: { stocktakeItemId: second.id } })).toBeNull()
    await expect(saveWarehouseStocktakeSection({ ...request, items: [{ itemId: first.id, countedQuantity: first.bookQuantity.plus(2).toString(), reason: '   ' }, { itemId: second.id, countedQuantity: second.bookQuantity.toString() }] })).rejects.toMatchObject({ statusCode: 400 })
    expect(await getWarehouseStocktake(tenantId, count.id)).toEqual(saved)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: saved.rowVersion, reason: '完整分区回滚验收结束' })
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
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/approve`,headers:{'x-role':'FINANCE'}})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/reject`,headers:{'x-role':'FINANCE'},payload:{reason:'财务不可审核退回'}})).statusCode).toBe(403)
    expect((await app.inject({url:`/api/warehouse-stocktakes/${count.id}`,headers:{'x-role':'FINANCE'}})).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/reverse` })).statusCode).toBe(404)
    await expect(createWarehouseStocktake({ tenantId: otherTenantId, userId, warehouseId, countDate: '2026-09-28', requestKey: randomUUID(), sections: [{ name: '跨租户', assignedToId: userId, productIds }] })).rejects.toMatchObject({ statusCode: 404 })
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: count.rowVersion, reason: '权限测试结束' })
  })
})
