import Fastify from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { warehouseStocktakeRoutes } from '../../src/routes/warehouseStocktake'
import {
  addWarehouseStocktakeItems,
  approveWarehouseStocktake,
  cancelWarehouseStocktake,
  createWarehouseStocktake,
  deleteWarehouseStocktake,
  executeWarehouseStocktakeBatch,
  generateFormalWarehouseStocktake,
  generateFormalWarehouseStocktakes,
  getWarehouseStocktake,
  listWarehouseStocktakes,
  removeWarehouseStocktakeItems,
  reorderWarehouseStocktakeItems,
  rejectWarehouseStocktake,
  reverseWarehouseStocktakeApproval,
  refreshWarehouseStocktakeUnits,
  reviewWarehouseStocktake,
  saveWarehouseStocktakeSection,
  submitWarehouseStocktake,
  updateWarehouseStocktakeHeader,
  withdrawWarehouseStocktake,
} from '../../src/services/warehouseStocktake'
import { recordWarehousePhysicalCount } from '../../src/services/warehouseLedger'
import { previewWarehouseStocktakeSelection } from '../../src/services/warehouseStocktakeSelection'
import { loadInventoryManagement, managementQuerySchema } from '../../src/services/inventoryManagement'
import { businessDateKey } from '../../src/lib/businessTime'
import {
  abandonWarehouseStocktakePrintJob,
  completeWarehouseStocktakePrintJob,
  getWarehouseStocktakePrintJob,
  prepareWarehouseStocktakePrintJob,
} from '../../src/services/warehouseStocktakePrint'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from '../../src/services/warehouseStocktakeConstants'

const suffix = `warehouse-stocktake-${randomUUID()}`
const TODAY = businessDateKey()
let tenantId = ''
let otherTenantId = ''
let warehouseId = ''
let userId = ''
let secondUserId = ''
let adminUserId = ''
let productIds: string[] = []
const app = Fastify()

async function waitForValue<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('等待并发测试状态超时')
}

async function createCount() {
  const result = await createWarehouseStocktake({
    tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(),
    sections: productIds.map((productId, index) => ({ name: `分区${index + 1}`, assignedToId: index ? secondUserId : userId, productIds: [productId] })),
  })
  return result.stocktake
}

async function fillAndSubmitSections(id: string, quantities: string[], submitUserId = userId) {
  let count = await getWarehouseStocktake(tenantId, id)
  await Promise.all(count.sections.map((section, index) => saveWarehouseStocktakeSection({
    tenantId, userId: section.assignedToId, stocktakeId: id, sectionId: section.id, rowVersion: section.rowVersion, submit: true,
    items: [{ itemId: section.items[0].id, countedQuantity: quantities[index], reason: quantities[index] === '10' ? null : '复核实盘' }],
  })))
  count = await getWarehouseStocktake(tenantId, id)
  return submitWarehouseStocktake({ tenantId, userId: submitUserId, id, rowVersion: count.rowVersion })
}

async function createAndApproveMixedCount() {
  const count = await createCount()
  await fillAndSubmitSections(count.id, count.sections.map((section, index) => section.items[0].bookQuantity.plus(index ? -1 : 1).toString()))
  await approveWarehouseStocktake({ tenantId, userId, id: count.id })
  return getWarehouseStocktake(tenantId, count.id)
}

async function cleanup(id: string) {
  await prisma.warehouseStocktakePrintJobItem.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakePrintJob.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeBatchOperationItem.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeBatchOperation.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeMergeSource.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeLifecycleEvent.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeAdjustmentLine.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeAdjustment.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktake.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseNetCostBasisConfirmation.deleteMany({ where: { tenantId: id } })
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
  const dedicated = process.env.STOCKTAKE_TEST_DATABASE === '1' && /^\/dianjie_stocktake_[a-z0-9_]+_test$/.test(testDb.pathname)
  if (testDb.hostname !== '127.0.0.1' || !dedicated) throw new Error('此测试仅限本轮新建隔离合成数据库')
  tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
  otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-other`, slug: `${suffix}-other` } })).id
  warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
  const users = await Promise.all(['盘点员一', '盘点员二'].map((name, index) => prisma.user.create({
    data: { tenantId, name, email: `${suffix}-${index}@test.local`, password: 'test', role: 'SUPPLY_CHAIN' },
  })))
  ;[userId, secondUserId] = users.map(user => user.id)
  adminUserId = (await prisma.user.create({ data: {
    tenantId, name: '盘点管理员', email: `${suffix}-admin@test.local`, password: 'test', role: 'ADMIN',
  } })).id
  for (let index = 0; index < 2; index += 1) {
    const product = await prisma.product.create({ data: {
      tenantId, code: `${suffix}-${index}`, name: `盘点商品${index}`, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', location: `P-0${index + 1}`, price: 10,
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
  it('多人盘点审核后显式生成独立正式盘点单，并发重试不重复', async () => {
    const sources = await Promise.all(productIds.map(async (productId, index) => {
      const owner = index ? secondUserId : userId
      const source = (await createWarehouseStocktake({ tenantId, userId: owner, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI', sections: [{ name: '多人盘点子单', assignedToId: owner, productIds: [productId] }] })).stocktake
      await fillAndSubmitSections(source.id, [source.sections[0].items[0].bookQuantity.toString()], owner)
      const audited = await approveWarehouseStocktake({ tenantId, userId, id: source.id })
      expect(audited.stocktake.auditedAt).not.toBeNull()
      expect(audited.stocktake.auditedById).toBe(userId)
      expect(audited.stocktake.reviewedAt).toBeNull()
      expect(audited.stocktake.reviewedById).toBeNull()
      return source
    }))

    await expect(reviewWarehouseStocktake({ tenantId, userId, id: sources[0].id })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: { in: sources.map(row => row.id) } } })).toBe(0)

    const replacement = await prisma.product.create({ data: {
      tenantId, code: `${suffix}-replacement`, name: '范围替换商品', unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 10,
    } })
    await prisma.product.update({ where: { id: productIds[0] }, data: { status: 'DISABLED' } })
    await expect(generateFormalWarehouseStocktakes({ tenantId, userId, sourceIds: sources.map(row => row.id), countScope: 'ALL' })).rejects.toMatchObject({ statusCode: 409 })
    await prisma.product.update({ where: { id: productIds[0] }, data: { status: 'ENABLED' } })
    await prisma.product.delete({ where: { id: replacement.id } })

    const generated = await Promise.all(Array.from({ length: 4 }, () => generateFormalWarehouseStocktakes({ tenantId, userId, sourceIds: sources.map(row => row.id), countScope: 'SELECTED' })))
    expect(generated.filter(result => !result.replayed)).toHaveLength(1)
    expect(new Set(generated.map(result => result.stocktake.id))).toHaveLength(1)
    const formal = generated[0].stocktake
    expect(formal).toMatchObject({ documentType: 'FORMAL', status: 'DRAFT', itemCount: 2 })
    expect(formal.sections[0].items.every(item => item.additionSource === 'MERGED')).toBe(true)
    expect(formal.sections[0].items.map(item => item.storageLocationSnapshot).sort()).toEqual(['P-01', 'P-02'])
    expect(formal.generatedFrom).toHaveLength(2)
    for (const source of sources) expect((await getWarehouseStocktake(tenantId, source.id)).generatedStocktakeId).toBe(formal.id)
    expect(await prisma.warehouseStocktakeMergeSource.count({ where: { tenantId, formalStocktakeId: formal.id } })).toBe(2)
    await expect(generateFormalWarehouseStocktakes({ tenantId, userId, sourceIds: sources.map(row => row.id), countScope: 'ALL' })).rejects.toMatchObject({ statusCode: 409 })

    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId, id: formal.id, rowVersion: formal.rowVersion, requestKey: randomUUID(), countDate: TODAY, note: '不得改生成单',
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(removeWarehouseStocktakeItems({
      tenantId, userId, id: formal.id, rowVersion: formal.rowVersion, requestKey: randomUUID(), itemIds: [formal.sections[0].items[0].id],
    })).rejects.toMatchObject({ statusCode: 409 })

    let formalDetail = await getWarehouseStocktake(tenantId, formal.id)
    await saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: formal.id, sectionId: formalDetail.sections[0].id, rowVersion: formalDetail.sections[0].rowVersion, submit: true, items: formalDetail.sections[0].items.map(item => ({ itemId: item.id, countedQuantity: item.bookQuantity.toString(), reason: null })) })
    let ready = await getWarehouseStocktake(tenantId, formal.id)
    await submitWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: ready.rowVersion })
    let reviewing = await getWarehouseStocktake(tenantId, formal.id)
    await withdrawWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '提交人补充复核' })
    let reopened = await getWarehouseStocktake(tenantId, formal.id)
    expect(reopened).toMatchObject({ status: 'COUNTING', generatedFrom: expect.arrayContaining([expect.objectContaining({ sourceStocktakeId: sources[0].id })]) })
    const changedQuantity = reopened.sections[0].items[0].bookQuantity.plus(1).toString()
    await saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: formal.id, sectionId: reopened.sections[0].id, rowVersion: reopened.sections[0].rowVersion, submit: true, items: reopened.sections[0].items.map((item, index) => ({ itemId: item.id, countedQuantity: index ? item.countedQuantity!.toString() : changedQuantity, reason: index ? item.reason : '撤回复核数量' })) })
    ready = await getWarehouseStocktake(tenantId, formal.id)
    await submitWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: ready.rowVersion })
    reviewing = await getWarehouseStocktake(tenantId, formal.id)
    await rejectWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '审核人要求再次复核' })
    reopened = await getWarehouseStocktake(tenantId, formal.id)
    expect(reopened).toMatchObject({ status: 'COUNTING', generatedFrom: expect.arrayContaining([expect.objectContaining({ sourceStocktakeId: sources[0].id })]) })
    expect(reopened.sections[0].items[0].countedQuantity?.toString()).toBe(changedQuantity)

    formalDetail = await getWarehouseStocktake(tenantId, formal.id)
    await saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: formal.id, sectionId: formalDetail.sections[0].id, rowVersion: formalDetail.sections[0].rowVersion, submit: true, items: formalDetail.sections[0].items.map(item => ({ itemId: item.id, countedQuantity: item.bookQuantity.toString(), reason: null })) })
    ready = await getWarehouseStocktake(tenantId, formal.id)
    await submitWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: ready.rowVersion })
    await approveWarehouseStocktake({ tenantId, userId, id: formal.id })
    const auditedFormal = await getWarehouseStocktake(tenantId, formal.id)
    expect(auditedFormal.auditedAt).not.toBeNull()
    expect(auditedFormal.auditedById).toBe(userId)
    expect(auditedFormal.reviewedAt).toBeNull()
    expect(auditedFormal.reviewedById).toBeNull()
    await reviewWarehouseStocktake({ tenantId, userId, id: formal.id })
    const reviewedFormal = await getWarehouseStocktake(tenantId, formal.id)
    expect(reviewedFormal.reviewStatus).toBe('REVIEWED')
    expect(reviewedFormal.reviewedAt).not.toBeNull()
    expect(reviewedFormal.reviewedById).toBe(userId)
    await expect(cancelWarehouseStocktake({ tenantId, userId, id: formal.id, rowVersion: (await getWarehouseStocktake(tenantId, formal.id)).rowVersion, reason: '不得取消来源正式单' })).rejects.toMatchObject({ statusCode: 409 })
    for (const source of sources) {
      const latest = await getWarehouseStocktake(tenantId, source.id)
      await expect(rejectWarehouseStocktake({ tenantId, userId, id: source.id, rowVersion: latest.rowVersion, requestKey: randomUUID(), reason: '不得退回已汇总来源' })).rejects.toMatchObject({ statusCode: 409 })
      await expect(cancelWarehouseStocktake({ tenantId, userId: adminUserId, id: source.id, rowVersion: latest.rowVersion, reason: '不得取消已汇总来源' })).rejects.toMatchObject({ statusCode: 409 })
    }
    expect((await prisma.warehouseStocktake.findUniqueOrThrow({ where: { id: formal.id } })).requestKey.length).toBeLessThanOrEqual(160)
    const ids=[formal.id,...sources.map(row=>row.id)]
    await prisma.warehouseStocktakeMergeSource.deleteMany({where:{tenantId,formalStocktakeId:formal.id}})
    await prisma.warehouseStocktakeLifecycleEvent.deleteMany({where:{tenantId,stocktakeId:{in:ids}}})
    await prisma.warehouseStocktakeAdjustmentLine.deleteMany({where:{tenantId,adjustment:{stocktakeId:{in:ids}}}})
    await prisma.warehouseStocktakeAdjustment.deleteMany({where:{tenantId,stocktakeId:{in:ids}}})
    await prisma.warehouseStocktakeEntry.deleteMany({where:{tenantId,stocktakeId:{in:ids}}})
    await prisma.warehouseStocktakeItem.deleteMany({where:{tenantId,stocktakeId:{in:ids}}})
    await prisma.warehouseStocktakeSection.deleteMany({where:{tenantId,stocktakeId:{in:ids}}})
    await prisma.warehouseStocktake.deleteMany({where:{tenantId,id:{in:ids}}})
  })

  it('多人盘点汇总在锁内限制正式单最多3000项且失败零写入', async () => {
    const source = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '多人盘点子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await fillAndSubmitSections(source.id, [source.sections[0].items[0].bookQuantity.toString()])
    await approveWarehouseStocktake({ tenantId, userId, id: source.id })

    const codePrefix = `${suffix}-formal-limit-`
    await prisma.product.createMany({ data: Array.from({ length: MAX_WAREHOUSE_STOCKTAKE_ITEMS }, (_, index) => ({
      tenantId, code: `${codePrefix}${index}`, name: `汇总边界商品${index}`, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' as const, price: 10, status: 'DISABLED' as const,
    })) })
    const synthetic = await prisma.product.findMany({ where: { tenantId, code: { startsWith: codePrefix } }, select: { id: true, code: true, name: true } })
    expect(synthetic).toHaveLength(MAX_WAREHOUSE_STOCKTAKE_ITEMS)
    await prisma.warehouseStocktakeItem.createMany({ data: synthetic.map((product, index) => ({
      tenantId, stocktakeId: source.id, sectionId: source.sections[0].id, productId: product.id,
      productCodeSnapshot: product.code, productNameSnapshot: product.name, additionSource: 'LEGACY', inventoryUnit: 'kg', unitPending: false,
      bookQuantity: 0, bookValue: 0, averageUnitCost: 0, bookBalanceVersion: 0, sortOrder: index + 1,
    })) })

    const before = await getWarehouseStocktake(tenantId, source.id)
    const formalCount = await prisma.warehouseStocktake.count({ where: { tenantId, documentType: 'FORMAL' } })
    const mergeCount = await prisma.warehouseStocktakeMergeSource.count({ where: { tenantId } })
    await expect(generateFormalWarehouseStocktakes({ tenantId, userId, sourceIds: [source.id], countScope: 'SELECTED' })).rejects.toMatchObject({ statusCode: 400 })
    const after = await getWarehouseStocktake(tenantId, source.id)
    expect(after.rowVersion).toBe(before.rowVersion)
    expect(after.generatedStocktakeId).toBeNull()
    expect(await prisma.warehouseStocktake.count({ where: { tenantId, documentType: 'FORMAL' } })).toBe(formalCount)
    expect(await prisma.warehouseStocktakeMergeSource.count({ where: { tenantId } })).toBe(mergeCount)
  })

  it('全部范围由服务器核对，漏项拒绝，双人分区不丢负责人', async () => {
    const preview = await previewWarehouseStocktakeSelection({ tenantId, warehouseId, countScope: 'ALL', countDate: TODAY })
    const input = { tenantId, userId, warehouseId, countScope: 'ALL' as const, countDate: TODAY, selectionFingerprint: preview.selectionFingerprint, requestKey: randomUUID(), sections: [{ name: '一', assignedToId: userId, productIds: [productIds[0]] }] }
    await expect(createWarehouseStocktake(input)).rejects.toMatchObject({ statusCode: 409 })
    const result = await createWarehouseStocktake({ ...input, sections: [...input.sections, { name: '二', assignedToId: secondUserId, productIds: [productIds[1]] }] })
    expect(result.stocktake.sections.map(section => section.assignedToId).sort()).toEqual([userId, secondUserId].sort())
    expect(result.stocktake.itemCount).toBe(2)
    expect(result.stocktake.countScope).toBe('ALL')
    await cancelWarehouseStocktake({ tenantId, userId, id: result.stocktake.id, rowVersion: result.stocktake.rowVersion, reason: '全量分区验收结束' })
  })

  it('MULTI子单明细已锁定后仍只允许创建人兼唯一负责人提交整单', async () => {
    const count = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '多人盘点子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: count.id, sectionId: count.sections[0].id, rowVersion: count.sections[0].rowVersion, submit: true,
      items: [{ itemId: count.sections[0].items[0].id, countedQuantity: count.sections[0].items[0].bookQuantity.toString() }],
    })
    const locked = await getWarehouseStocktake(tenantId, count.id)
    await expect(submitWarehouseStocktake({ tenantId, userId: secondUserId, id: count.id, rowVersion: locked.rowVersion })).rejects.toMatchObject({ statusCode: 403 })
    await submitWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: locked.rowVersion })
    await approveWarehouseStocktake({ tenantId, userId, id: count.id })
  })

  it('提交人只能在REVIEWING用原请求键幂等撤回，并重开所有分区', async () => {
    const count = await createCount()
    await fillAndSubmitSections(count.id, count.sections.map(section => section.items[0].bookQuantity.toString()))
    const reviewing = await getWarehouseStocktake(tenantId, count.id)
    expect(reviewing.status).toBe('REVIEWING')
    await expect(withdrawWarehouseStocktake({
      tenantId, userId: secondUserId, id: count.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '非提交人撤回',
    })).rejects.toMatchObject({ statusCode: 403 })

    const requestKey = randomUUID()
    const request = { tenantId, userId, id: count.id, rowVersion: reviewing.rowVersion, requestKey, reason: '补充实盘说明' }
    const results = await Promise.all(Array.from({ length: 3 }, () => withdrawWarehouseStocktake(request)))
    expect(results.filter(result => !result.replayed)).toHaveLength(1)
    expect(results.filter(result => result.replayed)).toHaveLength(2)
    const reopened = await getWarehouseStocktake(tenantId, count.id)
    expect(reopened.status).toBe('COUNTING')
    expect(reopened.submittedById).toBeNull()
    expect(reopened.sections.every(section => section.status === 'OPEN' && section.submittedAt == null)).toBe(true)
    const event = await prisma.warehouseStocktakeLifecycleEvent.findFirstOrThrow({ where: { tenantId, requestKey } })
    expect(event).toMatchObject({ action: 'WITHDRAW', cycle: 0, fromStatus: 'REVIEWING', toStatus: 'COUNTING' })
    await expect(withdrawWarehouseStocktake({ ...request, reason: '同键改变原因' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(withdrawWarehouseStocktake({ ...request, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: reopened.rowVersion, reason: '撤回验收结束' })
  })

  it('审核人驳回仅限REVIEWING且幂等，CONFIRMED必须走安全反审核', async () => {
    const count = await createCount()
    await fillAndSubmitSections(count.id, count.sections.map(section => section.items[0].bookQuantity.toString()))
    const reviewing = await getWarehouseStocktake(tenantId, count.id)
    const requestKey = randomUUID()
    const request = { tenantId, userId, id: count.id, rowVersion: reviewing.rowVersion, requestKey, reason: '请重新核对实盘数' }
    const first = await rejectWarehouseStocktake(request)
    const replay = await rejectWarehouseStocktake(request)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    const reopened = await getWarehouseStocktake(tenantId, count.id)
    expect(reopened.status).toBe('COUNTING')
    expect(reopened.sections.every(section => section.status === 'OPEN')).toBe(true)
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, requestKey, action: 'REJECT', cycle: 0 } })).toBe(1)
    await expect(rejectWarehouseStocktake({ ...request, requestKey: randomUUID(), rowVersion: reviewing.rowVersion })).rejects.toMatchObject({ statusCode: 409 })

    await fillAndSubmitSections(count.id, reopened.sections.map(section => section.items[0].bookQuantity.toString()))
    await approveWarehouseStocktake({ tenantId, userId, id: count.id })
    const approved = await getWarehouseStocktake(tenantId, count.id)
    await expect(rejectWarehouseStocktake({
      tenantId, userId, id: count.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '已审核不能驳回',
    })).rejects.toMatchObject({ statusCode: 409 })
    await reverseWarehouseStocktakeApproval({
      tenantId, userId, id: count.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '驳回边界验收后恢复',
    })
    const reversed = await getWarehouseStocktake(tenantId, count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: reversed.rowVersion, reason: '驳回验收结束' })
  })

  it('表头与人工增删商品按创建人/管理员、版本和请求键安全收口并重算汇总', async () => {
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), countScope: 'SELECTED',
      sections: [{ name: '单人盘点', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId: secondUserId, id: created.id, rowVersion: created.rowVersion, requestKey: randomUUID(), countDate: TODAY, note: '非创建人修改',
    })).rejects.toMatchObject({ statusCode: 403 })

    const headerRequest = {
      tenantId, userId: adminUserId, id: created.id, rowVersion: created.rowVersion, requestKey: randomUUID(), countDate: TODAY, note: '管理员核对表头',
    }
    const headerFirst = await updateWarehouseStocktakeHeader(headerRequest)
    const headerReplay = await updateWarehouseStocktakeHeader(headerRequest)
    expect(headerFirst.replayed).toBe(false)
    expect(headerReplay.replayed).toBe(true)
    expect(headerReplay.stocktake.countDate.toISOString().slice(0, 10)).toBe(TODAY)
    expect(headerReplay.stocktake.note).toBe('管理员核对表头')
    await expect(updateWarehouseStocktakeHeader({ ...headerRequest, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'HEADER_EDIT', cycle: 0 } })).toBe(1)

    const beforeAdd = await getWarehouseStocktake(tenantId, created.id)
    const oldSectionVersion = beforeAdd.sections[0].rowVersion
    const addRequest = {
      tenantId, userId, id: created.id, rowVersion: beforeAdd.rowVersion, requestKey: randomUUID(),
      sectionId: beforeAdd.sections[0].id, productIds: [productIds[1]],
    }
    const addResults = await Promise.all(Array.from({ length: 3 }, () => addWarehouseStocktakeItems(addRequest)))
    expect(addResults.filter(result => !result.replayed)).toHaveLength(1)
    expect(addResults.filter(result => result.replayed)).toHaveLength(2)
    const afterAdd = await getWarehouseStocktake(tenantId, created.id)
    expect(afterAdd.itemCount).toBe(2)
    expect(afterAdd.totalBookValue.toString()).toBe('200')
    expect(afterAdd.sections[0].rowVersion).toBe(oldSectionVersion + 1)
    await expect(saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: created.id, sectionId: afterAdd.sections[0].id, rowVersion: oldSectionVersion, submit: false,
      items: [{ itemId: afterAdd.sections[0].items[0].id, countedQuantity: '10' }],
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(addWarehouseStocktakeItems({ ...addRequest, requestKey: randomUUID(), rowVersion: afterAdd.rowVersion })).rejects.toMatchObject({ statusCode: 409 })

    const firstItem = afterAdd.sections[0].items.find(item => item.productId === productIds[0])!
    const secondItem = afterAdd.sections[0].items.find(item => item.productId === productIds[1])!
    const reorderRequest = {
      tenantId, userId, id: created.id, rowVersion: afterAdd.rowVersion, requestKey: randomUUID(),
      sectionId: afterAdd.sections[0].id, itemIds: [secondItem.id, firstItem.id],
    }
    const reordered = await reorderWarehouseStocktakeItems(reorderRequest)
    const reorderReplay = await reorderWarehouseStocktakeItems(reorderRequest)
    expect(reordered.replayed).toBe(false)
    expect(reorderReplay.replayed).toBe(true)
    const afterReorder = await getWarehouseStocktake(tenantId, created.id)
    expect(afterReorder.sections[0].items.map(item => item.id)).toEqual([secondItem.id, firstItem.id])
    await expect(reorderWarehouseStocktakeItems({ ...reorderRequest, rowVersion: afterReorder.rowVersion, requestKey: randomUUID(), itemIds: [firstItem.id] })).rejects.toMatchObject({ statusCode: 400 })
    await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: created.id, sectionId: afterReorder.sections[0].id, rowVersion: afterReorder.sections[0].rowVersion, submit: false,
      items: [
        { itemId: firstItem.id, countedQuantity: '12', reason: '盘盈复核' },
        { itemId: secondItem.id, countedQuantity: '10' },
      ],
    })
    const counted = await getWarehouseStocktake(tenantId, created.id)
    expect(counted).toMatchObject({ itemCount: 2, countedCount: 2, differenceCount: 1 })
    expect(counted.totalBookValue.toString()).toBe('200')
    expect(counted.totalCountedValue.toString()).toBe('220')
    expect(counted.totalDifferenceValue.toString()).toBe('20')

    const removeRequest = { tenantId, userId, id: created.id, rowVersion: counted.rowVersion, requestKey: randomUUID(), itemIds: [secondItem.id] }
    const removed = await removeWarehouseStocktakeItems(removeRequest)
    const removeReplay = await removeWarehouseStocktakeItems(removeRequest)
    expect(removed.replayed).toBe(false)
    expect(removeReplay.replayed).toBe(true)
    const afterRemove = await getWarehouseStocktake(tenantId, created.id)
    expect(afterRemove).toMatchObject({ itemCount: 1, countedCount: 1, differenceCount: 1 })
    expect(afterRemove.totalBookValue.toString()).toBe('100')
    expect(afterRemove.totalCountedValue.toString()).toBe('120')
    expect(afterRemove.totalDifferenceValue.toString()).toBe('20')
    expect(await prisma.warehouseStocktakeEntry.count({ where: { tenantId, stocktakeItemId: secondItem.id } })).toBe(0)
    await expect(removeWarehouseStocktakeItems({
      tenantId, userId, id: created.id, rowVersion: afterRemove.rowVersion, requestKey: randomUUID(), itemIds: [firstItem.id],
    })).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: { in: ['ITEM_ADD', 'ITEM_REMOVE'] }, cycle: 0 } })).toBe(2)
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'ITEM_REORDER', cycle: 0 } })).toBe(1)
    await cancelWarehouseStocktake({ tenantId, userId, id: created.id, rowVersion: afterRemove.rowVersion, reason: '表头增删验收结束' })
  })

  it('人工添加在锁内限制整单最多3000项且失败不写事件或版本', async () => {
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), countScope: 'SELECTED',
      sections: [{ name: '千项边界', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const codePrefix = `${suffix}-limit-`
    await prisma.product.createMany({ data: Array.from({ length: MAX_WAREHOUSE_STOCKTAKE_ITEMS - 1 }, (_, index) => ({
      tenantId, code: `${codePrefix}${index}`, name: `边界商品${index}`, unit: 'kg', inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' as const, price: 10, status: 'DISABLED' as const,
    })) })
    const synthetic = await prisma.product.findMany({ where: { tenantId, code: { startsWith: codePrefix } }, select: { id: true, code: true, name: true } })
    await prisma.warehouseStocktakeItem.createMany({ data: synthetic.map((product, index) => ({
      tenantId, stocktakeId: created.id, sectionId: created.sections[0].id, productId: product.id,
      productCodeSnapshot: product.code, productNameSnapshot: product.name, additionSource: 'LEGACY', inventoryUnit: 'kg', unitPending: false,
      bookQuantity: 0, bookValue: 0, averageUnitCost: 0, bookBalanceVersion: 0, sortOrder: index + 1,
    })) })
    const before = await getWarehouseStocktake(tenantId, created.id)
    const eventCount = await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'ITEM_ADD' } })
    await expect(addWarehouseStocktakeItems({
      tenantId, userId, id: created.id, rowVersion: before.rowVersion, requestKey: randomUUID(), sectionId: before.sections[0].id, productIds: [productIds[1]],
    })).rejects.toMatchObject({ statusCode: 400 })
    const after = await getWarehouseStocktake(tenantId, created.id)
    expect(after.rowVersion).toBe(before.rowVersion)
    expect(after.sections[0].rowVersion).toBe(before.sections[0].rowVersion)
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'ITEM_ADD' } })).toBe(eventCount)
    await cancelWarehouseStocktake({ tenantId, userId, id: created.id, rowVersion: after.rowVersion, reason: '千项边界验收结束' })
  })

  it('全部盘点首批禁止增删商品', async () => {
    const preview = await previewWarehouseStocktakeSelection({ tenantId, warehouseId, countScope: 'ALL', countDate: TODAY })
    const count = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), countScope: 'ALL', selectionFingerprint: preview.selectionFingerprint,
      sections: [{ name: '全部盘点', assignedToId: userId, productIds }],
    })).stocktake
    await expect(addWarehouseStocktakeItems({
      tenantId, userId, id: count.id, rowVersion: count.rowVersion, requestKey: randomUUID(), sectionId: count.sections[0].id, productIds: [productIds[0]],
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(removeWarehouseStocktakeItems({
      tenantId, userId, id: count.id, rowVersion: count.rowVersion, requestKey: randomUUID(), itemIds: [count.sections[0].items[0].id],
    })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: count.rowVersion, reason: '全部盘点验收结束' })
  })

  it('缺换算商品保留在服务器草稿，阻止录入提交；人工核验后刷新可恢复', async () => {
    const product = await prisma.product.create({ data: { tenantId, code: `${suffix}-PENDING`, name: '待补换算', unit: 'kg', inventoryUnit: 'kg', unitConversionStatus: 'PENDING', price: 10 } })
    const preview = await previewWarehouseStocktakeSelection({ tenantId, warehouseId, countScope: 'ALL', countDate: TODAY })
    const input = { tenantId, userId, warehouseId, countScope: 'ALL' as const, countDate: TODAY, selectionFingerprint: preview.selectionFingerprint, requestKey: randomUUID(), sections: [{ name: '完整范围', assignedToId: userId, productIds: [...productIds, product.id] }] }
    const count = (await createWarehouseStocktake(input)).stocktake
    const item = count.sections[0].items.find(item => item.productId === product.id)!
    expect(item.unitPending).toBe(true)
    expect(count.itemCount).toBe(3)
    expect(await prisma.warehouseLedgerBalance.count({ where: { tenantId, productId: product.id } })).toBe(0)
    await expect(saveWarehouseStocktakeSection({ tenantId, userId, stocktakeId: count.id, sectionId: count.sections[0].id, rowVersion: 0, submit: true, items: [{ itemId: item.id, countedQuantity: '0' }] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(refreshWarehouseStocktakeUnits({ tenantId, userId: secondUserId, id: count.id, rowVersion: count.rowVersion })).rejects.toMatchObject({ statusCode: 403 })
    await expect(refreshWarehouseStocktakeUnits({ tenantId, userId, id: count.id, rowVersion: count.rowVersion })).rejects.toMatchObject({ statusCode: 400 })
    await prisma.product.update({ where: { id: product.id }, data: { purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED' } })
    const refreshed = await refreshWarehouseStocktakeUnits({ tenantId, userId, id: count.id, rowVersion: count.rowVersion })
    expect(refreshed.sections[0].items.find(row => row.productId === product.id)?.unitPending).toBe(false)
    const replay = await createWarehouseStocktake(input)
    expect(replay.replayed).toBe(true)
    expect(replay.stocktake.id).toBe(count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: refreshed.rowVersion, reason: '缺换算草稿验收结束' })
    await prisma.product.update({ where: { id: product.id }, data: { status: 'DISABLED' } })
  })
  it('创建请求持久幂等，同仓只允许一张活动盘点单', async () => {
    const requestKey = randomUUID()
    const input = { tenantId, userId, warehouseId, countDate: TODAY, requestKey, sections: [{ name: '全仓', assignedToId: userId, productIds }] }
    const first = await createWarehouseStocktake(input)
    const replay = await createWarehouseStocktake(input)
    expect(replay.replayed).toBe(true)
    expect(replay.stocktake.id).toBe(first.stocktake.id)
    await expect(createWarehouseStocktake({ ...input, documentType: 'MULTI' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(createWarehouseStocktake({ ...input, countScope: 'ALL' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(createWarehouseStocktake({ ...input, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 })
    await expect(createWarehouseStocktake({ ...input, sections: [{ ...input.sections[0], name: '另一个分区' }] })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: first.stocktake.id, rowVersion: first.stocktake.rowVersion, reason: '幂等测试结束' })
    const concurrent = await Promise.allSettled([0, 1].map(() => createWarehouseStocktake({ ...input, requestKey: randomUUID() })))
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = concurrent.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof createWarehouseStocktake>>>
    await cancelWarehouseStocktake({ tenantId, userId, id: winner.value.stocktake.id, rowVersion: winner.value.stocktake.rowVersion, reason: '并发创建验收结束' })
  })

  it('LEGACY盘盈盘亏审核后追加一一对应冲销并精确恢复，幂等重放且再审核进入新轮次', async () => {
    const count = await createCount()
    const balancesBefore = await prisma.warehouseLedgerBalance.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { productId: 'asc' } })
    const lotsBefore = await prisma.warehouseLedgerLot.findMany({ where: { tenantId, productId: { in: productIds } }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    await fillAndSubmitSections(count.id, ['12', '8'])
    const approvals = await Promise.all(Array.from({ length: 4 }, () => approveWarehouseStocktake({ tenantId, userId, id: count.id })))
    expect(approvals.filter(row => !row.replayed)).toHaveLength(1)
    const approved = await getWarehouseStocktake(tenantId, count.id)
    expect(approved.status).toBe('CONFIRMED')
    expect(approved.auditedAt).not.toBeNull()
    expect(approved.auditedById).toBe(userId)
    expect(approved.reviewedAt).toBeNull()
    expect(approved.reviewedById).toBeNull()
    expect(approved.adjustments.map(row => row.type).sort()).toEqual(['LOSS', 'PROFIT'])
    await expect(rejectWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '已过账盘点必须走安全反审核' })).rejects.toMatchObject({ statusCode: 409 })
    const originals = await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id }, orderBy: { productId: 'asc' } })
    expect(originals).toHaveLength(2)
    for (const [index, quantity] of [12, 8].entries()) {
      const balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, productId: productIds[index] } })
      expect(Number(balance.physicalQty)).toBe(quantity)
      const lots = await prisma.warehouseLedgerLot.aggregate({ where: { tenantId, productId: productIds[index] }, _sum: { remainingQty: true } })
      expect(Number(lots._sum.remainingQty)).toBe(quantity)
    }

    const requestKey = randomUUID()
    const reverseInput = { tenantId, userId, id: count.id, rowVersion: approved.rowVersion, requestKey, reason: '复核发现录入错误' }
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => reverseWarehouseStocktakeApproval(reverseInput)))
    expect(concurrent.filter(row => !row.replayed)).toHaveLength(1)
    expect(concurrent.filter(row => row.replayed)).toHaveLength(2)
    const reversed = await getWarehouseStocktake(tenantId, count.id)
    expect(reversed).toMatchObject({ status: 'COUNTING', reviewStatus: 'UNREVIEWED', postingCycle: 1 })
    expect(reversed.sections.every(section => section.status === 'OPEN')).toBe(true)
    expect(reversed.sections.flatMap(section => section.items).every(item => item.approvedPostingSequence == null && item.approvedBalanceVersion == null)).toBe(true)
    expect(reversed.adjustments.every(row => row.status === 'REVERSED' && row.cycle === 1)).toBe(true)
    const afterOriginals = await prisma.warehouseLedgerMovement.findMany({ where: { id: { in: originals.map(row => row.id) } } })
    expect(afterOriginals).toHaveLength(originals.length)
    const reversals = await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, sourceType: 'WarehouseStocktakeReversal', sourceId: count.id }, orderBy: { productId: 'asc' } })
    expect(reversals).toHaveLength(2)
    expect(new Set(reversals.map(row => row.reversalOfId))).toEqual(new Set(originals.map(row => row.id)))
    for (const reversal of reversals) {
      const original = originals.find(row => row.id === reversal.reversalOfId)!
      expect(reversal.physicalDelta.equals(original.physicalDelta.negated())).toBe(true)
      expect(reversal.valueDelta.equals(original.valueDelta.negated())).toBe(true)
    }
    const balancesAfter = await prisma.warehouseLedgerBalance.findMany({ where: { tenantId, productId: { in: productIds } }, orderBy: { productId: 'asc' } })
    expect(balancesAfter.map(row => [row.productId, row.physicalQty.toString(), row.inventoryValue.toString()]))
      .toEqual(balancesBefore.map(row => [row.productId, row.physicalQty.toString(), row.inventoryValue.toString()]))
    const lotsAfter = await prisma.warehouseLedgerLot.findMany({ where: { tenantId, productId: { in: productIds }, id: { in: lotsBefore.map(row => row.id) } }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    expect(lotsAfter).toEqual(lotsBefore)
    await expect(reverseWarehouseStocktakeApproval({ ...reverseInput, reason: '相同键不同原因' })).rejects.toMatchObject({ statusCode: 409 })

    await fillAndSubmitSections(count.id, ['11', '9'])
    await approveWarehouseStocktake({ tenantId, userId: secondUserId, id: count.id })
    const cycleTwo = await getWarehouseStocktake(tenantId, count.id)
    expect(cycleTwo.postingCycle).toBe(2)
    expect(cycleTwo.adjustments.filter(row => row.cycle === 2).map(row => row.status)).toEqual(['POSTED', 'POSTED'])
    const cycleTwoMovements = await prisma.warehouseLedgerMovement.findMany({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id, idempotencyKey: { contains: ':c2:' } } })
    expect(cycleTwoMovements).toHaveLength(2)
    const profitList = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'profit', managementQuerySchema.parse({ start: '', end: '', dateField: 'date', filters: '{}', page: 1, pageSize: 100 })))
    const profitByNo = new Map(profitList.rows.filter(row => row.sourceNo === count.no).map(row => [row.no, row]))
    expect(profitByNo.get(`${count.no}-PY`)?.creator).toBe('盘点员一')
    expect(profitByNo.get(`${count.no}-PY-R2`)?.creator).toBe('盘点员二')
  })

  it('零差异不生成流水、调整单或重建批次', async () => {
    const beforeLots = await prisma.warehouseLedgerLot.findMany({ where: { tenantId }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    const count = await createCount()
    await fillAndSubmitSections(count.id, count.sections.map(section => section.items[0].bookQuantity.toString()))
    // 按本单冻结的当前账面数录入，因此全部为零差异。
    await approveWarehouseStocktake({ tenantId, userId, id: count.id })
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(0)
    expect(await prisma.warehouseStocktakeAdjustment.count({ where: { stocktakeId: count.id } })).toBe(0)
    const afterLots = await prisma.warehouseLedgerLot.findMany({ where: { tenantId }, select: { id: true, remainingQty: true }, orderBy: { id: 'asc' } })
    expect(afterLots).toEqual(beforeLots)
    const approved = await getWarehouseStocktake(tenantId, count.id)
    await reverseWarehouseStocktakeApproval({ tenantId, userId, id: count.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '零差异录入需重开' })
    expect((await getWarehouseStocktake(tenantId, count.id)).status).toBe('COUNTING')
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktakeReversal', sourceId: count.id } })).toBe(0)
    const reopened = await getWarehouseStocktake(tenantId, count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: reopened.rowVersion, reason: '零差异反审核验收结束' })
  })

  it('历史调整单没有APPROVE事件时仅回退到单据审核人', async () => {
    const approved = await createAndApproveMixedCount()
    await prisma.warehouseStocktakeLifecycleEvent.deleteMany({ where: { tenantId, stocktakeId: approved.id, action: 'APPROVE' } })
    const profitList = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'profit', managementQuerySchema.parse({ start: '', end: '', dateField: 'date', filters: '{}', page: 1, pageSize: 100 })))
    const row = profitList.rows.find(item => item.sourceNo === approved.no)
    expect(row?.creator).toBe('盘点员一')
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '历史事件缺失' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('后续同仓同商品零差异盘点已审核时阻断更早盘点反审核', async () => {
    const earlier = await createAndApproveMixedCount()
    const later = await createCount()
    await fillAndSubmitSections(later.id, later.sections.map(section => section.items[0].bookQuantity.toString()))
    await approveWarehouseStocktake({ tenantId, userId, id: later.id })
    const laterApproved = await getWarehouseStocktake(tenantId, later.id)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: later.id } })).toBe(0)
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: earlier.id, rowVersion: earlier.rowVersion, requestKey: randomUUID(), reason: '不得破坏后续零差异快照' })).rejects.toMatchObject({ statusCode: 409 })
    expect((await getWarehouseStocktake(tenantId, later.id)).status).toBe('CONFIRMED')
    expect((await getWarehouseStocktake(tenantId, later.id)).rowVersion).toBe(laterApproved.rowVersion)
  })

  it('并发零差异审核先排队时，反审核持有余额锁后重查并拒绝', async () => {
    const earlier = await createAndApproveMixedCount()
    const later = await createCount()
    await fillAndSubmitSections(later.id, later.sections.map(section => section.items[0].bookQuantity.toString()))
    const reviewingLater = await getWarehouseStocktake(tenantId, later.id)

    let releaseBalanceLock!: () => void
    let reportBlockerPid!: (pid: number) => void
    const release = new Promise<void>(resolve => { releaseBalanceLock = resolve })
    const blockerPid = new Promise<number>(resolve => { reportBlockerPid = resolve })
    const blocker = prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "warehouse_ledger_balances"
        WHERE "tenantId"=${tenantId} AND "warehouseId"=${warehouseId}
          AND "productId" IN (${Prisma.join(productIds)})
        ORDER BY "productId" FOR UPDATE
      `)
      const rows = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS pid`)
      reportBlockerPid(rows[0].pid)
      await release
    }, { timeout: 15_000 })
    const pid = await blockerPid
    const blockedCount = async () => {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity AS activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS n FROM blocked
      `)
      return rows[0].n
    }
    const waitForBlocked = async (minimum: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await blockedCount() >= minimum) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`等待${minimum}个余额锁排队事务超时`)
    }

    let approvalResult: Awaited<ReturnType<typeof approveWarehouseStocktake>> | undefined
    let reversalError: any
    try {
      const laterApproval = approveWarehouseStocktake({ tenantId, userId, id: later.id })
      await waitForBlocked(1)
      const reversal = reverseWarehouseStocktakeApproval({ tenantId, userId, id: earlier.id, rowVersion: earlier.rowVersion, requestKey: randomUUID(), reason: '并发时序保护' })
        .catch(error => { reversalError = error; return undefined })
      await waitForBlocked(2)
      releaseBalanceLock()
      await blocker
      ;[approvalResult] = await Promise.all([laterApproval, reversal])
    } finally {
      releaseBalanceLock()
      await blocker.catch(() => undefined)
    }
    expect(approvalResult).toBeDefined()
    expect(reversalError).toMatchObject({ statusCode: 409 })
    expect((await getWarehouseStocktake(tenantId, later.id)).status).toBe('CONFIRMED')
    expect((await getWarehouseStocktake(tenantId, earlier.id)).status).toBe('CONFIRMED')
    expect(reviewingLater.status).toBe('REVIEWING')
  })

  it('本轮盘点流水已核定库存池净成本时保守阻断反审核', async () => {
    const approved = await createAndApproveMixedCount()
    const movement = await prisma.warehouseLedgerMovement.findFirstOrThrow({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: approved.id, physicalDelta: { gt: 0 } } })
    await prisma.warehouseNetCostBasisConfirmation.create({ data: {
      tenantId, warehouseId, productId: movement.productId, movementId: movement.id,
      netValueDelta: null, poolNetValueAfter: movement.valueAfter, physicalAfterSnapshot: movement.physicalAfter,
      grossValueAfterSnapshot: movement.valueAfter, postingSequenceSnapshot: movement.postingSequence,
      grossValueDeltaSnapshot: movement.valueDelta, physicalDeltaSnapshot: movement.physicalDelta,
      inventoryUnitSnapshot: movement.inventoryUnit, basisType: 'POOL_DOCUMENT', taxRate: null,
      evidenceRefs: ['document:stocktake-pool-test'], confirmedById: userId, requestKey: randomUUID(),
      requestFingerprint: 'a'.repeat(64), version: 1,
    } })
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '净成本核定后禁止' })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceType: 'WarehouseStocktakeReversal', sourceId: approved.id } })).toBe(0)
  })

  it('反审核保守阻断旧版本、后续流水、批次消耗、缺凭据、已复审与MULTI', async () => {
    let approved = await createAndApproveMixedCount()
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion - 1, requestKey: randomUUID(), reason: '旧页面请求' })).rejects.toMatchObject({ statusCode: 409 })
    await recordWarehousePhysicalCount({
      tenantId, userId, productId: productIds[0], countedInventoryQuantity: approved.sections[0].items[0].countedQuantity!,
      countedInventoryValue: approved.sections[0].items[0].countedValue!, effectiveAt: new Date(), idempotencyKey: randomUUID(),
    })
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '已有后续流水' })).rejects.toMatchObject({ statusCode: 409 })

    approved = await createAndApproveMixedCount()
    const profitMovement = await prisma.warehouseLedgerMovement.findFirstOrThrow({ where: { tenantId, sourceType: 'WarehouseStocktake', sourceId: approved.id, physicalDelta: { gt: 0 } }, include: { createdLot: true } })
    await prisma.warehouseLedgerLot.update({ where: { id: profitMovement.createdLot!.id }, data: { remainingQty: { decrement: '0.5' } } })
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '盘盈批次已消耗' })).rejects.toMatchObject({ statusCode: 409 })
    await prisma.warehouseLedgerLot.update({ where: { id: profitMovement.createdLot!.id }, data: { remainingQty: { increment: '0.5' } } })

    approved = await createAndApproveMixedCount()
    const reservedBalance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId, warehouseId, productId: productIds[0] } })
    await prisma.warehouseLedgerBalance.update({ where: { id: reservedBalance.id }, data: { reservedQty: { increment: 1 }, rowVersion: { increment: 1 } } })
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '预占发生变化' })).rejects.toMatchObject({ statusCode: 409 })
    await prisma.warehouseLedgerBalance.update({ where: { id: reservedBalance.id }, data: { reservedQty: { decrement: 1 }, rowVersion: { increment: 1 } } })

    approved = await createAndApproveMixedCount()
    await prisma.warehouseStocktakeItem.update({ where: { id: approved.sections[0].items[0].id }, data: { approvedPostingSequence: null } })
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: approved.rowVersion, requestKey: randomUUID(), reason: '历史凭据缺失' })).rejects.toMatchObject({ statusCode: 409 })

    approved = await createAndApproveMixedCount()
    await reviewWarehouseStocktake({ tenantId, userId, id: approved.id })
    const reviewed = await getWarehouseStocktake(tenantId, approved.id)
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: approved.id, rowVersion: reviewed.rowVersion, requestKey: randomUUID(), reason: '已复审禁止' })).rejects.toMatchObject({ statusCode: 409 })

    const multi = (await createWarehouseStocktake({ tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI', sections: [{ name: '多人盘点子单', assignedToId: userId, productIds: [productIds[0]] }] })).stocktake
    await expect(reverseWarehouseStocktakeApproval({ tenantId, userId, id: multi.id, rowVersion: multi.rowVersion, requestKey: randomUUID(), reason: '多人单禁止' })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: multi.id, rowVersion: multi.rowVersion, reason: '阻断测试结束' })
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
    const result = await createWarehouseStocktake({ tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), sections: [{ name: '完整分区校验', assignedToId: userId, productIds }] })
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
    await fillAndSubmitSections(count.id, count.sections.map(section => section.items[0].bookQuantity.toString()))
    const changedQuantity = count.sections[1].items[0].bookQuantity.plus(1)
    await recordWarehousePhysicalCount({ tenantId, userId, productId: productIds[1], countedInventoryQuantity: changedQuantity, countedInventoryValue: changedQuantity.mul(10), effectiveAt: new Date(), idempotencyKey: randomUUID() })
    await expect(approveWarehouseStocktake({ tenantId, userId, id: count.id })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseStocktakeAdjustment.count({ where: { stocktakeId: count.id } })).toBe(0)
    expect(await prisma.warehouseLedgerMovement.count({ where: { sourceType: 'WarehouseStocktake', sourceId: count.id } })).toBe(0)
    expect((await getWarehouseStocktake(tenantId, count.id)).status).toBe('REVIEWING')
    const reviewing = await getWarehouseStocktake(tenantId, count.id)
    await rejectWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '库存已变动' })
    const rejected = await getWarehouseStocktake(tenantId, count.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: count.id, rowVersion: rejected.rowVersion, reason: '重新发起盘点' })
  })

  it('盘点单与多人盘点单使用数据库稳定分页并返回总页数和勾选版本', async () => {
    for (const pageId of ['count', 'multi-count'] as const) {
      const query = (page: number) => managementQuerySchema.parse({
        start: '', end: '', dateField: 'date', filters: '{}', page, pageSize: 1,
      })
      const first = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, pageId, query(1)))
      const second = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, pageId, query(2)))
      const repeated = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, pageId, query(1)))
      expect(first.total).toBeGreaterThan(1)
      expect(first.totalPages).toBe(first.total)
      expect(first.rows).toHaveLength(1)
      expect(second.rows).toHaveLength(1)
      expect(first.rows[0].id).not.toBe(second.rows[0].id)
      expect(repeated.rows[0].id).toBe(first.rows[0].id)
      expect(first.rows[0].rowVersion).toEqual(expect.any(Number))
    }
  })

  it('作业页列表在盘点日期和创建时间相同时仍按ID稳定分页', async () => {
    const marker = `stable-list-${randomUUID()}`
    const ids: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const stocktake = (await createWarehouseStocktake({
        tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI', note: marker,
        sections: [{ name: `稳定分页${index + 1}`, assignedToId: userId, productIds: [productIds[0]] }],
      })).stocktake
      ids.push(stocktake.id)
      await cancelWarehouseStocktake({ tenantId, userId, id: stocktake.id, rowVersion: stocktake.rowVersion, reason: '稳定分页测试' })
    }
    await prisma.warehouseStocktake.updateMany({
      where: { tenantId, id: { in: ids } },
      data: { countDate: new Date(`${TODAY}T00:00:00.000Z`), createdAt: new Date(`${TODAY}T01:02:03.000Z`) },
    })
    const request = (page: number) => ({ tenantId, documentType: 'MULTI' as const, q: marker, page, pageSize: 1 })
    const first = await listWarehouseStocktakes(request(1))
    const second = await listWarehouseStocktakes(request(2))
    const repeated = await listWarehouseStocktakes(request(1))
    expect(first.total).toBe(2)
    expect([first.rows[0].id, second.rows[0].id]).toEqual([...ids].sort().reverse())
    expect(repeated.rows[0].id).toBe(first.rows[0].id)
  })

  it('批量提交逐单交易，保留勾选版本冲突并可安全重放', async () => {
    const ready = []
    for (let index = 0; index < 2; index += 1) {
      const owner = index ? secondUserId : userId
      const created = (await createWarehouseStocktake({
        tenantId, userId: owner, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
        sections: [{ name: '多人盘点子单', assignedToId: owner, productIds: [productIds[index]] }],
      })).stocktake
      await saveWarehouseStocktakeSection({
        tenantId, userId: owner, stocktakeId: created.id, sectionId: created.sections[0].id, rowVersion: created.sections[0].rowVersion,
        submit: true, items: [{ itemId: created.sections[0].items[0].id, countedQuantity: created.sections[0].items[0].bookQuantity.toString() }],
      })
      ready.push(await getWarehouseStocktake(tenantId, created.id))
    }
    const requestKey = randomUUID()
    const input = {
      tenantId, userId, requestKey, action: 'SUBMIT' as const, ignoreInvalid: true,
      items: [{ id: ready[0].id, rowVersion: ready[0].rowVersion }, { id: ready[1].id, rowVersion: ready[1].rowVersion - 1 }],
    }
    const first = await executeWarehouseStocktakeBatch(input)
    expect(first.summary).toMatchObject({ total: 2, succeeded: 1, failed: 1, skipped: 0, pending: 0 })
    expect(first.results.find(item => item.id === ready[1].id)).toMatchObject({ outcome: 'FAILED', code: 'VERSION_CONFLICT' })
    expect((await getWarehouseStocktake(tenantId, ready[0].id)).status).toBe('REVIEWING')
    expect((await getWarehouseStocktake(tenantId, ready[1].id)).status).toBe('COUNTING')
    const operation = await prisma.warehouseStocktakeBatchOperation.findUniqueOrThrow({ where: { tenantId_requestKey: { tenantId, requestKey } } })
    const succeededItem = await prisma.warehouseStocktakeBatchOperationItem.findFirstOrThrow({ where: { tenantId, operationId: operation.id, stocktakeId: ready[0].id } })
    // 模拟领域提交已成功、进程在批量 item 写 SUCCEEDED 前崩溃。
    await prisma.warehouseStocktakeBatchOperation.update({ where: { id: operation.id }, data: { status: 'RUNNING', completedAt: null } })
    await prisma.warehouseStocktakeBatchOperationItem.update({ where: { id: succeededItem.id }, data: {
      status: 'RUNNING', outputRowVersion: null, errorCode: null, message: null, leaseToken: 'expired-test-lease', leaseExpiresAt: new Date(0),
    } })
    const recovered = await executeWarehouseStocktakeBatch(input)
    expect(recovered.results.find(item => item.id === ready[0].id)).toMatchObject({ outcome: 'SUCCEEDED', message: '已根据单据转换证据恢复批量结果' })
    const replay = await executeWarehouseStocktakeBatch(input)
    expect(replay.replayed).toBe(true)
    expect(replay.results.map(item => [item.id, item.outcome, item.code])).toEqual(recovered.results.map(item => [item.id, item.outcome, item.code]))
    expect(await prisma.warehouseStocktakeBatchOperation.count({ where: { tenantId, requestKey } })).toBe(1)
    expect(await prisma.warehouseStocktakeBatchOperationItem.count({ where: { tenantId } })).toBeGreaterThanOrEqual(2)
    await expect(executeWarehouseStocktakeBatch({ ...input, items: [input.items[0]] })).rejects.toMatchObject({ statusCode: 409 })
    const remaining = await getWarehouseStocktake(tenantId, ready[1].id)
    await cancelWarehouseStocktake({ tenantId, userId: secondUserId, id: remaining.id, rowVersion: remaining.rowVersion, reason: '批量测试结束' })
  })

  it('租约接管者读到旧版本后等待旧worker提交，冲突会重读转换证据并收敛成功', async () => {
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '租约接管子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: created.id, sectionId: created.sections[0].id, rowVersion: created.sections[0].rowVersion,
      submit: true, items: [{ itemId: created.sections[0].items[0].id, countedQuantity: created.sections[0].items[0].bookQuantity.toString() }],
    })
    const ready = await getWarehouseStocktake(tenantId, created.id)
    const input = {
      tenantId, userId, requestKey: randomUUID(), action: 'SUBMIT' as const, ignoreInvalid: false,
      items: [{ id: ready.id, rowVersion: ready.rowVersion }],
    }
    let releaseGate!: () => void
    let gateReady!: () => void
    const release = new Promise<void>(resolve => { releaseGate = resolve })
    const locked = new Promise<void>(resolve => { gateReady = resolve })
    const gate = prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktakes" WHERE "tenantId" = ${tenantId} AND "id" = ${ready.id} FOR UPDATE`)
      gateReady()
      await release
    }, { timeout: 30_000 })
    await locked
    try {
      const firstWorker = executeWarehouseStocktakeBatch(input)
      const firstLease = await waitForValue(
        () => prisma.warehouseStocktakeBatchOperationItem.findFirst({ where: { tenantId, stocktakeId: ready.id, operation: { requestKey: input.requestKey } } }),
        item => item?.status === 'RUNNING' && item.attemptCount === 1 && Boolean(item.leaseToken),
      )
      await prisma.warehouseStocktakeBatchOperationItem.update({
        where: { id: firstLease!.id },
        data: { leaseExpiresAt: new Date(0) },
      })
      const secondWorker = executeWarehouseStocktakeBatch(input)
      await waitForValue(
        () => prisma.warehouseStocktakeBatchOperationItem.findUnique({ where: { id: firstLease!.id } }),
        item => item?.status === 'RUNNING' && item.attemptCount === 2 && item.leaseToken !== firstLease!.leaseToken,
      )
      await waitForValue(
        () => prisma.$queryRaw<Array<{ waiting: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "waiting" FROM pg_stat_activity
          WHERE datname = current_database()
            AND "wait_event_type" = 'Lock'
            AND query LIKE '%warehouse_stocktakes%FOR UPDATE%'
        `),
        rows => Number(rows[0]?.waiting || 0) >= 2,
      )
      releaseGate()
      await Promise.all([gate, firstWorker, secondWorker])
    } catch (error) {
      releaseGate()
      await gate.catch(() => undefined)
      throw error
    }
    const replay = await executeWarehouseStocktakeBatch(input)
    expect(replay.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0, pending: 0 })
    expect(replay.results[0]).toMatchObject({ outcome: 'SUCCEEDED', message: '已根据单据转换证据恢复批量结果' })
    expect(await prisma.warehouseStocktakeBatchOperationItem.findFirstOrThrow({
      where: { tenantId, stocktakeId: ready.id, operation: { requestKey: input.requestKey } },
    })).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 })
    const reviewing = await getWarehouseStocktake(tenantId, ready.id)
    await rejectWarehouseStocktake({ tenantId, userId, id: reviewing.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '租约并发测试结束' })
    const rejected = await getWarehouseStocktake(tenantId, ready.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: rejected.id, rowVersion: rejected.rowVersion, reason: '租约并发测试结束' })
  })

  it('不同批次并发提交同一张单据时仅一笔成功，另一笔稳定返回版本冲突', async () => {
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '并发批量子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: created.id, sectionId: created.sections[0].id, rowVersion: created.sections[0].rowVersion,
      submit: true, items: [{ itemId: created.sections[0].items[0].id, countedQuantity: created.sections[0].items[0].bookQuantity.toString() }],
    })
    const ready = await getWarehouseStocktake(tenantId, created.id)
    const base = {
      tenantId, userId, action: 'SUBMIT' as const, ignoreInvalid: false,
      items: [{ id: ready.id, rowVersion: ready.rowVersion }],
    }
    const results = await Promise.all([
      executeWarehouseStocktakeBatch({ ...base, requestKey: randomUUID() }),
      executeWarehouseStocktakeBatch({ ...base, requestKey: randomUUID() }),
    ])
    expect(results.map(result => result.summary.succeeded).sort()).toEqual([0, 1])
    expect(results.flatMap(result => result.results).find(item => item.outcome === 'FAILED')).toMatchObject({ code: 'VERSION_CONFLICT' })
    const reviewing = await getWarehouseStocktake(tenantId, ready.id)
    expect(reviewing.status).toBe('REVIEWING')
    await rejectWarehouseStocktake({ tenantId, userId, id: reviewing.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '并发测试结束' })
    const rejected = await getWarehouseStocktake(tenantId, ready.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: rejected.id, rowVersion: rejected.rowVersion, reason: '并发测试结束' })
  })

  it('批量端点执行角色和租户隔离，未知ID只返回通用失败', async () => {
    const requestKey = randomUUID()
    const payload = { requestKey, ignoreInvalid: true, items: [{ id: randomUUID(), rowVersion: 0 }] }
    expect((await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes/batch/approve', headers: { 'x-role': 'FINANCE' }, payload })).statusCode).toBe(403)
    const [response, concurrentReplay] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/warehouse-stocktakes/batch/approve', payload }),
      app.inject({ method: 'POST', url: '/api/warehouse-stocktakes/batch/approve', payload }),
    ])
    expect(response.statusCode).toBe(200)
    expect(concurrentReplay.statusCode).toBe(200)
    const replay = await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes/batch/approve', payload })
    expect(replay.json()).toMatchObject({ summary: { total: 1, succeeded: 0, failed: 1 }, results: [{ outcome: 'FAILED', code: 'NOT_FOUND', message: '盘点单不存在或无权访问' }] })
    expect(await prisma.warehouseStocktakeBatchOperation.count({ where: { tenantId, requestKey } })).toBe(1)
    expect(await prisma.warehouseStocktakeBatchOperationItem.count({ where: { tenantId, operation: { requestKey } } })).toBe(1)
  })

  it('软删除并发幂等且只隐藏主单，保留明细审计并阻止原创建请求重建', async () => {
    const createKey = randomUUID()
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: createKey, documentType: 'MULTI',
      sections: [{ name: '待删除子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const itemCount = await prisma.warehouseStocktakeItem.count({ where: { tenantId, stocktakeId: created.id } })
    const sectionCount = await prisma.warehouseStocktakeSection.count({ where: { tenantId, stocktakeId: created.id } })
    const request = { tenantId, userId, id: created.id, rowVersion: created.rowVersion, requestKey: randomUUID(), reason: '录入错误需要删除' }
    const results = await Promise.all(Array.from({ length: 3 }, () => deleteWarehouseStocktake(request)))
    expect(results.filter(result => !result.replayed)).toHaveLength(1)
    expect(results.filter(result => result.replayed)).toHaveLength(2)
    await expect(getWarehouseStocktake(tenantId, created.id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await listWarehouseStocktakes({ tenantId, documentType: 'MULTI', page: 1, pageSize: 100 })).rows.map(row => row.id)).not.toContain(created.id)
    const management = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'multi-count', managementQuerySchema.parse({
      start: '', end: '', dateField: 'date', filters: '{}', page: 1, pageSize: 100,
    })))
    expect(management.rows.map(row => row.detailId)).not.toContain(created.id)
    expect(await prisma.warehouseStocktakeSection.count({ where: { tenantId, stocktakeId: created.id } })).toBe(sectionCount)
    expect(await prisma.warehouseStocktakeItem.count({ where: { tenantId, stocktakeId: created.id } })).toBe(itemCount)
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'DELETE' } })).toBe(1)
    expect(await prisma.opLog.count({ where: { tenantId, targetId: created.id, action: '软删除总仓盘点单' } })).toBe(1)
    await expect(createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: createKey, documentType: 'MULTI',
      sections: [{ name: '待删除子单', assignedToId: userId, productIds: [productIds[0]] }],
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(deleteWarehouseStocktake({ ...request, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('软删除执行创建人或管理员权限、状态与活动单唯一索引边界', async () => {
    const first = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(),
      sections: [{ name: '普通盘点', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await expect(deleteWarehouseStocktake({ tenantId, userId: secondUserId, id: first.id, rowVersion: first.rowVersion, requestKey: randomUUID(), reason: '越权删除测试' })).rejects.toMatchObject({ statusCode: 403 })
    await deleteWarehouseStocktake({ tenantId, userId: adminUserId, id: first.id, rowVersion: first.rowVersion, requestKey: randomUUID(), reason: '管理员删除错误草稿' })
    const replacement = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(),
      sections: [{ name: '替换盘点', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    await fillAndSubmitSections(replacement.id, [replacement.sections[0].items[0].bookQuantity.toString()])
    const reviewing = await getWarehouseStocktake(tenantId, replacement.id)
    await expect(deleteWarehouseStocktake({ tenantId, userId, id: reviewing.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '待审核不能删除' })).rejects.toMatchObject({ statusCode: 409 })
    await rejectWarehouseStocktake({ tenantId, userId, id: reviewing.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '删除边界测试退回' })
    const reopened = await getWarehouseStocktake(tenantId, replacement.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: reopened.id, rowVersion: reopened.rowVersion, reason: '删除边界测试取消' })
    const cancelled = await getWarehouseStocktake(tenantId, replacement.id)
    await deleteWarehouseStocktake({ tenantId, userId, id: cancelled.id, rowVersion: cancelled.rowVersion, requestKey: randomUUID(), reason: '删除已取消盘点' })
  })

  it('批量删除逐项保留失败并安全重放，跨租户和已删除单据不泄漏', async () => {
    const deletable = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '批量删除', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const reviewingSource = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '批量不可删除', assignedToId: userId, productIds: [productIds[1]] }],
    })).stocktake
    await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: reviewingSource.id, sectionId: reviewingSource.sections[0].id, rowVersion: reviewingSource.sections[0].rowVersion,
      submit: true, items: [{ itemId: reviewingSource.sections[0].items[0].id, countedQuantity: reviewingSource.sections[0].items[0].bookQuantity.toString() }],
    })
    const ready = await getWarehouseStocktake(tenantId, reviewingSource.id)
    await submitWarehouseStocktake({ tenantId, userId, id: ready.id, rowVersion: ready.rowVersion })
    const reviewing = await getWarehouseStocktake(tenantId, ready.id)
    const input = {
      tenantId, userId, action: 'DELETE' as const, requestKey: randomUUID(), ignoreInvalid: true, reason: '批量清理错误盘点',
      items: [{ id: deletable.id, rowVersion: deletable.rowVersion }, { id: reviewing.id, rowVersion: reviewing.rowVersion }, { id: randomUUID(), rowVersion: 0 }],
    }
    const first = await executeWarehouseStocktakeBatch(input)
    expect(first.summary).toMatchObject({ total: 3, succeeded: 1, skipped: 1, failed: 1 })
    expect(first.results.find(item => item.id === deletable.id)).toMatchObject({ outcome: 'SUCCEEDED' })
    expect(first.results.find(item => item.id === reviewing.id)).toMatchObject({ outcome: 'SKIPPED', code: 'INVALID_STATE' })
    expect(first.results.find(item => ![deletable.id, reviewing.id].includes(item.id))).toMatchObject({ outcome: 'FAILED', code: 'NOT_FOUND', message: '盘点单不存在或无权访问' })
    const replay = await executeWarehouseStocktakeBatch(input)
    expect(replay.replayed).toBe(true)
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: deletable.id, action: 'DELETE' } })).toBe(1)
    const unrelatedReplay = await executeWarehouseStocktakeBatch({
      tenantId,
      userId,
      action: 'DELETE',
      requestKey: randomUUID(),
      ignoreInvalid: true,
      reason: '新批次不得识别已删除单据',
      items: [{ id: deletable.id, rowVersion: deletable.rowVersion }],
    })
    expect(unrelatedReplay.results).toEqual([
      expect.objectContaining({ id: deletable.id, outcome: 'FAILED', code: 'NOT_FOUND', message: '盘点单不存在或无权访问' }),
    ])
    await rejectWarehouseStocktake({ tenantId, userId, id: reviewing.id, rowVersion: reviewing.rowVersion, requestKey: randomUUID(), reason: '批量删除测试结束' })
    const reopened = await getWarehouseStocktake(tenantId, reviewing.id)
    await cancelWarehouseStocktake({ tenantId, userId, id: reopened.id, rowVersion: reopened.rowVersion, reason: '批量删除测试结束' })
  })

  it('DELETE领域已提交但批次项租约过期时仅同operation接管恢复', async () => {
    const created = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: 'DELETE租约恢复', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const reason = '模拟删除提交后进程中断'
    const requestKey = randomUUID()
    const input = {
      tenantId,
      userId,
      requestKey,
      action: 'DELETE' as const,
      ignoreInvalid: true,
      reason,
      items: [{ id: created.id, rowVersion: created.rowVersion }],
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      action: input.action,
      actorId: userId,
      items: input.items,
      ignoreInvalid: input.ignoreInvalid,
      reason,
    })).digest('hex')
    const operation = await prisma.warehouseStocktakeBatchOperation.create({
      data: {
        tenantId,
        requestKey,
        requestFingerprint,
        action: 'DELETE',
        actorId: userId,
        reason,
        items: { create: { stocktakeId: created.id, inputRowVersion: created.rowVersion } },
      },
      include: { items: true },
    })
    const item = operation.items[0]
    await prisma.warehouseStocktakeBatchOperationItem.update({
      where: { id: item.id },
      data: { status: 'RUNNING', attemptCount: 1, leaseToken: 'crashed-delete-worker', leaseExpiresAt: new Date(0) },
    })
    await deleteWarehouseStocktake({
      tenantId,
      userId,
      id: created.id,
      rowVersion: created.rowVersion,
      requestKey: `wst-batch-item:${operation.id}:${item.id}`,
      reason,
      batchItemId: item.id,
    })

    let releaseGate!: () => void
    let gateReady!: () => void
    const release = new Promise<void>(resolve => { releaseGate = resolve })
    const locked = new Promise<void>(resolve => { gateReady = resolve })
    const gate = prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktake_batch_operation_items" WHERE "id" = ${item.id} FOR UPDATE`)
      gateReady()
      await release
    }, { timeout: 30_000 })
    await locked
    try {
      const workers = [executeWarehouseStocktakeBatch(input), executeWarehouseStocktakeBatch(input)]
      await waitForValue(
        () => prisma.$queryRaw<Array<{ waiting: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS "waiting" FROM pg_stat_activity
          WHERE datname = current_database()
            AND "wait_event_type" = 'Lock'
            AND query LIKE '%warehouse_stocktake_batch_operation_items%'
        `),
        rows => Number(rows[0]?.waiting || 0) >= 1,
      )
      releaseGate()
      await Promise.all(workers)
    } catch (error) {
      releaseGate()
      await gate.catch(() => undefined)
      throw error
    }
    await gate

    const recovered = await executeWarehouseStocktakeBatch(input)
    expect(recovered).toMatchObject({ replayed: true, status: 'COMPLETED', summary: { total: 1, succeeded: 1, failed: 0, pending: 0 } })
    expect(recovered.results[0]).toMatchObject({ outcome: 'SUCCEEDED', message: '已根据单据转换证据恢复批量结果', rowVersion: created.rowVersion + 1 })
    expect(await prisma.warehouseStocktakeBatchOperationItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      status: 'SUCCEEDED', attemptCount: 2, leaseToken: null, outputRowVersion: created.rowVersion + 1,
    })
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'DELETE' } })).toBe(1)
    expect(await prisma.opLog.count({ where: { tenantId, targetId: created.id, action: '软删除总仓盘点单' } })).toBe(1)

    const unrelated = await executeWarehouseStocktakeBatch({ ...input, requestKey: randomUUID() })
    expect(unrelated.results).toEqual([
      expect.objectContaining({ id: created.id, outcome: 'FAILED', code: 'NOT_FOUND', message: '盘点单不存在或无权访问' }),
    ])
    expect(await prisma.warehouseStocktakeLifecycleEvent.count({ where: { tenantId, stocktakeId: created.id, action: 'DELETE' } })).toBe(1)
    expect(await prisma.opLog.count({ where: { tenantId, targetId: created.id, action: '软删除总仓盘点单' } })).toBe(1)
  })

  it('软删除阻断过账留痕、自关联正反向与汇总关联证据', async () => {
    const approved = await createAndApproveMixedCount()
    const reversed = await reverseWarehouseStocktakeApproval({
      tenantId,
      userId,
      id: approved.id,
      rowVersion: approved.rowVersion,
      requestKey: randomUUID(),
      reason: '反审后仍必须保留过账证据',
    })
    await expect(deleteWarehouseStocktake({
      tenantId,
      userId,
      id: approved.id,
      rowVersion: reversed.stocktake.rowVersion,
      requestKey: randomUUID(),
      reason: '不得删除过账留痕',
    })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({ tenantId, userId, id: approved.id, rowVersion: reversed.stocktake.rowVersion, reason: '证据阻断测试结束' })

    const selfTarget = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '自关联目标', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const selfSource = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '自关联来源', assignedToId: userId, productIds: [productIds[1]] }],
    })).stocktake
    await prisma.warehouseStocktake.update({ where: { id: selfSource.id }, data: { sourceMultiId: selfTarget.id } })
    await expect(deleteWarehouseStocktake({ tenantId, userId, id: selfSource.id, rowVersion: selfSource.rowVersion, requestKey: randomUUID(), reason: '正向自关联阻断' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(deleteWarehouseStocktake({ tenantId, userId, id: selfTarget.id, rowVersion: selfTarget.rowVersion, requestKey: randomUUID(), reason: '反向自关联阻断' })).rejects.toMatchObject({ statusCode: 409 })

    const mergeSource = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '汇总来源', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    const mergeFormal = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name: '汇总目标', assignedToId: userId, productIds: [productIds[1]] }],
    })).stocktake
    await prisma.warehouseStocktakeMergeSource.create({ data: {
      tenantId,
      sourceStocktakeId: mergeSource.id,
      formalStocktakeId: mergeFormal.id,
    } })
    await expect(deleteWarehouseStocktake({ tenantId, userId, id: mergeSource.id, rowVersion: mergeSource.rowVersion, requestKey: randomUUID(), reason: '汇总来源证据阻断' })).rejects.toMatchObject({ statusCode: 409 })
    await expect(deleteWarehouseStocktake({ tenantId, userId, id: mergeFormal.id, rowVersion: mergeFormal.rowVersion, requestKey: randomUUID(), reason: '汇总目标证据阻断' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('详情Excel只导出库存单位，打印任务保留顺序、幂等完成并标记改后待重打', async () => {
    const createMulti = async (name: string, productId: string) => (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), documentType: 'MULTI',
      sections: [{ name, assignedToId: userId, productIds: [productId] }],
    })).stocktake
    const first = await createMulti('打印一', productIds[0])
    const second = await createMulti('打印二', productIds[1])
    const requestKey = randomUUID()
    const prepared = await prepareWarehouseStocktakePrintJob({ tenantId, userId, requestKey, ids: [second.id, first.id] })
    expect(prepared).toMatchObject({ replayed: false, job: { status: 'PREPARED', itemCount: 2 } })
    const document = await getWarehouseStocktakePrintJob(tenantId, userId, prepared.job.id)
    expect(document.documents.map(row => row.id)).toEqual([second.id, first.id])
    expect(document.documents[1].items[0]).toMatchObject({ storageLocation: 'P-01', additionSource: 'MANUAL' })
    await prisma.product.update({ where: { id: productIds[0] }, data: { location: 'P-99' } })
    expect((await getWarehouseStocktakePrintJob(tenantId, userId, prepared.job.id)).documents[1].items[0].storageLocation).toBe('P-01')
    await prisma.product.update({ where: { id: productIds[0] }, data: { location: 'P-01' } })
    await expect(getWarehouseStocktakePrintJob(tenantId, secondUserId, prepared.job.id)).rejects.toMatchObject({ statusCode: 404 })
    const otherActorRead = await app.inject({ url: `/api/warehouse-stocktakes/print-jobs/${prepared.job.id}`, headers: { 'x-user': secondUserId } })
    expect(otherActorRead.statusCode).toBe(404)
    expect(otherActorRead.body).not.toContain(requestKey)
    expect(otherActorRead.body).not.toContain(first.id)
    expect((await prepareWarehouseStocktakePrintJob({ tenantId, userId, requestKey, ids: [second.id, first.id] })).replayed).toBe(true)
    await expect(prepareWarehouseStocktakePrintJob({ tenantId, userId, requestKey, ids: [first.id, second.id] })).rejects.toMatchObject({ statusCode: 409 })
    await expect(prepareWarehouseStocktakePrintJob({ tenantId: otherTenantId, userId, requestKey: randomUUID(), ids: [first.id] })).rejects.toMatchObject({ statusCode: 404 })

    const completed = await Promise.all(Array.from({ length: 2 }, () => completeWarehouseStocktakePrintJob({
      tenantId, userId, id: prepared.job.id, requestKey,
    })))
    expect(completed.filter(result => !result.replayed)).toHaveLength(1)
    expect(completed.filter(result => result.replayed)).toHaveLength(1)
    for (const id of [first.id, second.id]) expect(await prisma.warehouseStocktake.findUniqueOrThrow({ where: { id } })).toMatchObject({ printCount: 1, lastPrintedById: userId })
    const currentQuery = managementQuerySchema.parse({ start: '', end: '', dateField: 'date', filters: JSON.stringify({ printed: '已打印' }), page: 1, pageSize: 100 })
    expect((await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'multi-count', currentQuery))).rows.map(row => row.detailId)).toEqual(expect.arrayContaining([first.id, second.id]))

    const edited = await updateWarehouseStocktakeHeader({
      tenantId, userId, id: first.id, rowVersion: first.rowVersion, requestKey: randomUUID(), countDate: TODAY, note: '打印后修改',
    })
    expect(edited.stocktake.rowVersion).toBe(first.rowVersion + 1)
    const staleQuery = managementQuerySchema.parse({ start: '', end: '', dateField: 'date', filters: JSON.stringify({ printed: '修改后待重打' }), page: 1, pageSize: 100 })
    const stale = await prisma.$transaction(tx => loadInventoryManagement(tx, tenantId, 'multi-count', staleQuery))
    expect(stale.rows.find(row => row.detailId === first.id)?.printed).toBe('修改后待重打')

    const third = await createMulti('删除后禁止完成打印', productIds[0])
    const pendingKey = randomUUID()
    const pending = await prepareWarehouseStocktakePrintJob({ tenantId, userId, requestKey: pendingKey, ids: [third.id] })
    await deleteWarehouseStocktake({ tenantId, userId, id: third.id, rowVersion: third.rowVersion, requestKey: randomUUID(), reason: '验证打印任务不可完成' })
    await expect(completeWarehouseStocktakePrintJob({ tenantId, userId, id: pending.job.id, requestKey: pendingKey })).rejects.toMatchObject({ statusCode: 409 })
    expect((await abandonWarehouseStocktakePrintJob({ tenantId, userId, id: pending.job.id, requestKey: pendingKey })).job.status).toBe('ABANDONED')
    expect((await prisma.warehouseStocktake.findUniqueOrThrow({ where: { id: third.id } })).printCount).toBe(0)

    const exported = await app.inject({ url: `/api/warehouse-stocktakes/${first.id}/export`, headers: { 'x-role': 'FINANCE', 'x-user': userId } })
    expect(exported.statusCode, exported.body).toBe(200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(exported.json().fileBase64, 'base64') as any)
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['盘点单', '盘点明细'])
    const itemSheet = workbook.getWorksheet('盘点明细')!
    const headers = itemSheet.getRow(1).values as any[]
    expect(headers).toContain('库存单位')
    expect(headers).toContain('库位')
    expect(headers).toContain('添加方式')
    expect(headers.some(value => String(value).includes('辅助单位'))).toBe(false)
    expect(itemSheet.getRow(2).getCell(headers.indexOf('库位')).value).toMatch(/^P-0[12]$/)
    expect(itemSheet.getRow(2).getCell(headers.indexOf('添加方式')).value).toBe('手工添加')
    const bookQuantityColumn = headers.indexOf('账面数量')
    expect(itemSheet.getRow(2).getCell(bookQuantityColumn).value).toMatch(/^\d+\.\d{6}$/)

    const financeKey = randomUUID()
    const financePrepare = await app.inject({
      method: 'POST', url: '/api/warehouse-stocktakes/print-jobs',
      headers: { 'x-role': 'FINANCE', 'x-user': userId }, payload: { requestKey: financeKey, ids: [second.id] },
    })
    expect(financePrepare.statusCode, financePrepare.body).toBe(201)
    const financeJobId = financePrepare.json().job.id
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/print-jobs/${financeJobId}/abandon`, headers: { 'x-role': 'FINANCE', 'x-user': userId }, payload: { requestKey: financeKey } })).statusCode).toBe(200)
  })

  it('真实反审核API执行角色、租户与状态校验', async () => {
    const count = await createCount()
    const payload = { reason: '权限边界验证', rowVersion: count.rowVersion, requestKey: randomUUID() }
    expect((await app.inject({ url: `/api/warehouse-stocktakes/${count.id}`, headers: { 'x-tenant': otherTenantId } })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/warehouse-stocktakes/${count.id}`, headers: { 'x-role': 'PURCHASER' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes', headers: { 'x-role': 'PURCHASER' }, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/approve`, headers: { 'x-role': 'PURCHASER' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/warehouse-stocktakes', headers: { 'x-role': 'FINANCE' }, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/approve`,headers:{'x-role':'FINANCE'}})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/reject`,headers:{'x-role':'FINANCE'},payload:{reason:'财务不可审核退回'}})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/delete`,headers:{'x-role':'FINANCE'},payload:{reason:'财务不可删除',rowVersion:count.rowVersion,requestKey:randomUUID()}})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:`/api/warehouse-stocktakes/${count.id}/delete`,headers:{'x-tenant':otherTenantId},payload:{reason:'跨租户不可删除',rowVersion:count.rowVersion,requestKey:randomUUID()}})).statusCode).toBe(404)
    expect((await app.inject({url:`/api/warehouse-stocktakes/${count.id}`,headers:{'x-role':'FINANCE'}})).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/reverse-approval`, headers: { 'x-role': 'FINANCE' }, payload })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/reverse-approval`, headers: { 'x-tenant': otherTenantId }, payload })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/reverse-approval`, payload })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/submit`, headers: { 'x-user': secondUserId }, payload: { rowVersion: count.rowVersion } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/cancel`, headers: { 'x-user': secondUserId }, payload: { rowVersion: count.rowVersion, reason: '非创建人不可取消' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/refresh-units`, headers: { 'x-user': adminUserId, 'x-role': 'ADMIN' }, payload: { rowVersion: count.rowVersion } })).statusCode).toBe(200)
    await expect(createWarehouseStocktake({ tenantId: otherTenantId, userId, warehouseId, countDate: TODAY, requestKey: randomUUID(), sections: [{ name: '跨租户', assignedToId: userId, productIds }] })).rejects.toMatchObject({ statusCode: 404 })
    expect((await app.inject({ method: 'POST', url: `/api/warehouse-stocktakes/${count.id}/cancel`, headers: { 'x-user': adminUserId, 'x-role': 'ADMIN' }, payload: { rowVersion: count.rowVersion, reason: '管理员结束权限测试' } })).statusCode).toBe(200)
  })
})
