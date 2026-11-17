import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { businessDateKey, businessDateOnlyRange } from '../../src/lib/businessTime'
import { recordWarehousePhysicalCount } from '../../src/services/warehouseLedger'
import {
  addWarehouseStocktakeItems,
  cancelWarehouseStocktake,
  createWarehouseStocktake,
  getWarehouseStocktake,
  listWarehouseStocktakeLogs,
  removeWarehouseStocktakeItems,
  rejectWarehouseStocktake,
  saveWarehouseStocktakeSection,
  submitWarehouseStocktake,
  updateWarehouseStocktakeHeader,
  warehouseStocktakeOptions,
} from '../../src/services/warehouseStocktake'
import {
  createWarehouseStocktakePlan,
  updateWarehouseStocktakePlan,
  upsertWarehouseStocktakeProductPolicy,
} from '../../src/services/warehouseStocktakePlans'
import { previewWarehouseStocktakeSelection } from '../../src/services/warehouseStocktakeSelection'
import { buildWarehouseStocktakeWorkbook } from '../../src/services/warehouseStocktakeArtifacts'

const suffix = `stocktake-selection-${randomUUID()}`
let tenantId = ''
let otherTenantId = ''
let warehouseId = ''
let userId = ''
let otherUserId = ''
let productIds: string[] = []

async function cleanup(id: string) {
  await prisma.warehouseStocktakeProductPolicyChange.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeProductPolicy.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeMergeSource.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeLifecycleEvent.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeAdjustmentLine.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeAdjustment.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeEntry.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeItem.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakeSection.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktake.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakePlanChange.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakePlanItem.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseStocktakePlan.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseNetCostBasisConfirmation.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId: id } })
  await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId: id } })
  await prisma.opLog.deleteMany({ where: { tenantId: id } })
  await prisma.businessSequence.deleteMany({ where: { tenantId: id } })
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
  userId = (await prisma.user.create({ data: {
    tenantId, name: '圈定管理员', email: `${suffix}@test.local`, password: 'test', role: 'ADMIN',
  } })).id
  otherUserId = (await prisma.user.create({ data: {
    tenantId: otherTenantId, name: '其他租户用户', email: `${suffix}-other@test.local`, password: 'test', role: 'ADMIN',
  } })).id
  for (let index = 0; index < 2; index += 1) {
    const product = await prisma.product.create({ data: {
      tenantId,
      code: `${suffix}-${index}`,
      name: `圈定商品${index}`,
      unit: 'kg',
      inventoryUnit: 'kg',
      purchaseUnit: 'kg',
      orderUnit: 'kg',
      costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED',
      location: `A-0${index + 1}`,
      price: 10,
    } })
    productIds.push(product.id)
    await recordWarehousePhysicalCount({
      tenantId,
      userId,
      productId: product.id,
      countedInventoryQuantity: index + 2,
      countedInventoryValue: (index + 2) * 10,
      effectiveAt: new Date(),
      idempotencyKey: randomUUID(),
    })
  }
})

afterAll(async () => {
  if (tenantId) await cleanup(tenantId)
  if (otherTenantId) await cleanup(otherTenantId)
  await prisma.$disconnect()
})

describe('盘点方案与自动圈定', () => {
  it('只选一个正式菌菇可保存，并排除改过分类的BOM临时商品和本地配方镜像', async () => {
    const today = businessDateKey()
    const [mushroom, bom, localRecipe] = await Promise.all([
      prisma.product.create({ data: {
        tenantId, code: `${suffix}-ZZ9M-MUSHROOM`, name: '正式人工菌', category: '人工菌', unit: 'kg',
        inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
        inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED', price: 12,
      } }),
      prisma.product.create({ data: {
        tenantId, code: `DJ-BOM-${randomUUID().slice(0, 10)}`, name: '错误混入的配方菌菇', category: '人工菌', unit: 'kg',
        inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
        inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED', price: 1,
      } }),
      prisma.product.create({ data: {
        tenantId, code: `${suffix}-LOCAL-RECIPE`, name: '本地配方临时商品', category: '本地配方镜像', unit: 'kg',
        inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
        inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED', price: 1,
      } }),
    ])
    let createdId = ''
    const temporaryIds = [mushroom.id, bom.id, localRecipe.id]
    try {
      const optionIds = new Set((await warehouseStocktakeOptions(tenantId)).products.map(product => product.id))
      expect(optionIds.has(mushroom.id)).toBe(true)
      expect(optionIds.has(bom.id)).toBe(false)
      expect(optionIds.has(localRecipe.id)).toBe(false)

      for (const forbiddenId of [bom.id, localRecipe.id]) {
        await expect(previewWarehouseStocktakeSelection({
          tenantId, warehouseId, countDate: today, countScope: 'SELECTED', manualProductIds: [forbiddenId],
        })).rejects.toMatchObject({ statusCode: 409 })
      }

      const preview = await previewWarehouseStocktakeSelection({
        tenantId, warehouseId, countDate: today, countScope: 'SELECTED', manualProductIds: [mushroom.id],
      })
      expect(preview.products.map(product => product.id)).toEqual([mushroom.id])

      const unrelated = await prisma.product.create({ data: {
        tenantId, code: `${suffix}-UNRELATED-${randomUUID().slice(0, 8)}`, name: '无关新商品', unit: 'kg',
        inventoryUnit: 'kg', purchaseUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
        inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED', price: 1,
      } })
      temporaryIds.push(unrelated.id)
      const created = await createWarehouseStocktake({
        tenantId, userId, warehouseId, countDate: today, requestKey: randomUUID(), countScope: 'SELECTED',
        selectionFingerprint: preview.selectionFingerprint,
        sections: [{ name: '只盘菌菇', assignedToId: userId, productIds: [mushroom.id] }],
      })
      createdId = created.stocktake.id
      expect(created.stocktake.itemCount).toBe(1)
      expect(created.stocktake.sections[0].items.map(item => item.productId)).toEqual([mushroom.id])
      expect(await prisma.warehouseLedgerBalance.count({ where: { tenantId, warehouseId, productId: mushroom.id } })).toBe(1)
    } finally {
      if (createdId) {
        const current = await getWarehouseStocktake(tenantId, createdId)
        if (['DRAFT', 'COUNTING', 'CANCELLED'].includes(current.status) && current.status !== 'CANCELLED') {
          await cancelWarehouseStocktake({ tenantId, userId, id: createdId, rowVersion: current.rowVersion, reason: '指定菌菇保存回归结束' })
        }
      }
      await prisma.product.updateMany({ where: { id: { in: temporaryIds } }, data: { status: 'DISABLED' } })
    }
  })

  it('严格绑定scope/rule/period，方案创建必须预览指纹且同key稳定重放', async () => {
    const today = businessDateKey()
    const createdPlan = await createWarehouseStocktakePlan({
      tenantId,
      userId,
      requestKey: randomUUID(),
      name: '重点商品方案',
      warehouseId,
      countScope: 'SELECTED',
      selectionRule: 'FIXED_PLAN_PRODUCTS',
      productIds: [productIds[0]],
    })
    const plan = createdPlan.plan
    const preview = await previewWarehouseStocktakeSelection({
      tenantId,
      warehouseId,
      countDate: today,
      countScope: 'SELECTED',
      planId: plan.id,
    })
    expect(preview.products.map(row => row.id)).toEqual([productIds[0]])
    expect(preview.selectionRule).toBe('FIXED_PLAN_PRODUCTS')

    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'ALL', planId: plan.id,
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'SELECTED', planId: plan.id, selectionRule: 'BOOK_NONZERO_AS_OF',
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'SELECTED', selectionRule: 'ALL_ENABLED',
    })).rejects.toMatchObject({ statusCode: 400 })
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'SELECTED', selectionRule: 'PERIOD_MOVEMENT_OR_OPENING', periodUnit: 'DAY',
    })).rejects.toMatchObject({ statusCode: 400 })

    const requestKey = randomUUID()
    const createInput = {
      tenantId,
      userId,
      requestKey,
      warehouseId,
      countDate: today,
      countScope: 'SELECTED' as const,
      planId: plan.id,
      selectionFingerprint: preview.selectionFingerprint,
      sections: [{ name: '方案圈定', assignedToId: userId, productIds: [productIds[0]] }],
    }
    await expect(createWarehouseStocktake({ ...createInput, requestKey: randomUUID(), selectionFingerprint: null })).rejects.toMatchObject({ statusCode: 400 })
    const created = await createWarehouseStocktake(createInput)
    const replay = await createWarehouseStocktake(createInput)
    expect(created.replayed).toBe(false)
    expect(created.stocktake.sections[0].items[0]).toMatchObject({ storageLocationSnapshot: 'A-01', additionSource: 'PLAN' })
    expect(replay.replayed).toBe(true)
    expect(replay.stocktake.id).toBe(created.stocktake.id)
    await expect(createWarehouseStocktake({ ...createInput, countScope: 'ALL' })).rejects.toMatchObject({ statusCode: 409 })
    const previousDay = businessDateKey(new Date(businessDateOnlyRange(today).start.getTime() - 1))
    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId, id: created.stocktake.id, rowVersion: created.stocktake.rowVersion,
      requestKey: randomUUID(), countDate: previousDay, note: '不允许换日期',
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(addWarehouseStocktakeItems({
      tenantId, userId, id: created.stocktake.id, rowVersion: created.stocktake.rowVersion,
      requestKey: randomUUID(), sectionId: created.stocktake.sections[0].id, productIds: [productIds[1]],
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(removeWarehouseStocktakeItems({
      tenantId, userId, id: created.stocktake.id, rowVersion: created.stocktake.rowVersion,
      requestKey: randomUUID(), itemIds: [created.stocktake.sections[0].items[0].id],
    })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({
      tenantId, userId, id: created.stocktake.id, rowVersion: created.stocktake.rowVersion, reason: '圈定测试结束',
    })

    const planUpdateKey = randomUUID()
    const planUpdateInput = {
      tenantId,
      userId,
      requestKey: planUpdateKey,
      id: plan.id,
      rowVersion: plan.rowVersion,
      name: plan.name,
      warehouseId,
      countScope: 'SELECTED',
      selectionRule: 'FIXED_PLAN_PRODUCTS',
      productIds: [productIds[0]],
      note: '方案版本已变更',
    }
    const updated = await updateWarehouseStocktakePlan(planUpdateInput)
    const updateReplay = await updateWarehouseStocktakePlan(planUpdateInput)
    expect(updateReplay.id).toBe(updated.id)
    expect(updateReplay.rowVersion).toBe(updated.rowVersion)
    expect(await prisma.warehouseStocktakePlanChange.count({ where: { tenantId, requestKey: planUpdateKey } })).toBe(1)
    await expect(createWarehouseStocktake({ ...createInput, requestKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 })
    expect(updated.rowVersion).toBe(plan.rowVersion + 1)

    await prisma.product.update({ where: { id: productIds[0] }, data: { status: 'DISABLED' } })
    const disabled = await updateWarehouseStocktakePlan({
      tenantId,
      userId,
      requestKey: randomUUID(),
      id: updated.id,
      rowVersion: updated.rowVersion,
      name: updated.name,
      warehouseId: updated.warehouseId,
      countScope: 'SELECTED',
      selectionRule: 'FIXED_PLAN_PRODUCTS',
      productIds: updated.items.map(item => item.productId),
      note: updated.note,
      status: 'DISABLED',
    })
    expect(disabled.status).toBe('DISABLED')
    await prisma.product.update({ where: { id: productIds[0] }, data: { status: 'ENABLED' } })
  })

  it('方案并发创建可重放，并发更新只一个成功且另一个稳定409', async () => {
    const requestKey = randomUUID()
    const input = {
      tenantId, userId, requestKey, name: '并发方案', warehouseId, countScope: 'ALL' as const,
      selectionRule: 'ALL_ENABLED' as const, productIds: [],
    }
    const createResults = await Promise.all([createWarehouseStocktakePlan(input), createWarehouseStocktakePlan(input)])
    expect(new Set(createResults.map(row => row.plan.id))).toHaveLength(1)
    expect(createResults.filter(row => row.replayed)).toHaveLength(1)
    expect(await prisma.warehouseStocktakePlan.count({ where: { tenantId, requestKey } })).toBe(1)

    const plan = createResults[0].plan
    const updates = await Promise.allSettled([
      updateWarehouseStocktakePlan({ ...input, requestKey: randomUUID(), id: plan.id, rowVersion: plan.rowVersion, name: '并发方案A' }),
      updateWarehouseStocktakePlan({ ...input, requestKey: randomUUID(), id: plan.id, rowVersion: plan.rowVersion, name: '并发方案B' }),
    ])
    expect(updates.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const rejected = updates.find(row => row.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ statusCode: 409 })

    const sequenceResults = await Promise.allSettled([0, 1].map(index => createWarehouseStocktakePlan({
      ...input, requestKey: randomUUID(), name: `序号竞争${index}`,
    })))
    expect(sequenceResults.every(row => row.status === 'fulfilled')).toBe(true)
  })

  it('商品政策首建并发只一个成功，requestKey重放不重复增版本或日志', async () => {
    const firstKey = randomUUID()
    const secondKey = randomUUID()
    const writes = await Promise.allSettled([
      upsertWarehouseStocktakeProductPolicy({
        tenantId, userId, warehouseId, productId: productIds[1], canCount: true, defaultIncluded: false,
        reason: '默认不纳入', rowVersion: 0, requestKey: firstKey,
      }),
      upsertWarehouseStocktakeProductPolicy({
        tenantId, userId, warehouseId, productId: productIds[1], canCount: false, defaultIncluded: false,
        reason: '暂停盘点', rowVersion: 0, requestKey: secondKey,
      }),
    ])
    expect(writes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const failed = writes.find(row => row.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ statusCode: 409 })
    const winnerIndex = writes.findIndex(row => row.status === 'fulfilled')
    const winnerKey = winnerIndex === 0 ? firstKey : secondKey
    const winnerPayload = winnerIndex === 0
      ? { canCount: true, defaultIncluded: false, reason: '默认不纳入' }
      : { canCount: false, defaultIncluded: false, reason: '暂停盘点' }
    const policy = await prisma.warehouseStocktakeProductPolicy.findFirstOrThrow({ where: { tenantId, warehouseId, productId: productIds[1] } })
    expect(policy.rowVersion).toBe(1)
    const opLogsBefore = await prisma.opLog.count({ where: { tenantId, entityType: 'WarehouseStocktakeProductPolicy', targetId: policy.id } })
    const changesBefore = await prisma.warehouseStocktakeProductPolicyChange.count({ where: { tenantId, policyId: policy.id } })
    const replay = await upsertWarehouseStocktakeProductPolicy({
      tenantId, userId, warehouseId, productId: productIds[1], ...winnerPayload, rowVersion: 0, requestKey: winnerKey,
    }) as any
    expect(replay.rowVersion).toBe(1)
    expect((await prisma.warehouseStocktakeProductPolicy.findUniqueOrThrow({ where: { id: policy.id } })).rowVersion).toBe(1)
    expect(await prisma.opLog.count({ where: { tenantId, entityType: 'WarehouseStocktakeProductPolicy', targetId: policy.id } })).toBe(opLogsBefore)
    expect(await prisma.warehouseStocktakeProductPolicyChange.count({ where: { tenantId, policyId: policy.id } })).toBe(changesBefore)
    await expect(upsertWarehouseStocktakeProductPolicy({
      tenantId, userId, warehouseId, productId: productIds[1], canCount: true, defaultIncluded: true,
      reason: null, rowVersion: 0, requestKey: winnerKey,
    })).rejects.toMatchObject({ statusCode: 409 })
    await upsertWarehouseStocktakeProductPolicy({
      tenantId, userId, warehouseId, productId: productIds[1], canCount: true, defaultIncluded: true,
      reason: null, rowVersion: 1, requestKey: randomUUID(),
    })
    const manual = await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: businessDateKey(), requestKey: randomUUID(),
      sections: [{ name: '手工政策验证', assignedToId: userId, productIds: [productIds[0]] }],
    })
    await upsertWarehouseStocktakeProductPolicy({
      tenantId, userId, warehouseId, productId: productIds[1], canCount: false, defaultIncluded: false,
      reason: '政策禁盘', rowVersion: 2, requestKey: randomUUID(),
    })
    await expect(addWarehouseStocktakeItems({
      tenantId, userId, id: manual.stocktake.id, rowVersion: manual.stocktake.rowVersion,
      requestKey: randomUUID(), sectionId: manual.stocktake.sections[0].id, productIds: [productIds[1]],
    })).rejects.toMatchObject({ statusCode: 409 })
    const todayRange = businessDateOnlyRange(businessDateKey())
    const yesterday = businessDateKey(new Date(todayRange.start.getTime() - 1))
    const tomorrow = businessDateKey(new Date(todayRange.endExclusive.getTime() + 1))
    const headerKey = randomUUID()
    const headerInput = {
      tenantId, userId, id: manual.stocktake.id, rowVersion: manual.stocktake.rowVersion,
      requestKey: headerKey, countDate: businessDateKey(), note: '当日表头幂等测试',
    }
    const headerChanged = await updateWarehouseStocktakeHeader({ ...headerInput, now: todayRange.start })
    const crossDayReplay = await updateWarehouseStocktakeHeader({ ...headerInput, now: todayRange.endExclusive })
    expect(crossDayReplay.replayed).toBe(true)
    expect(crossDayReplay.stocktake.id).toBe(headerChanged.stocktake.id)
    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId, id: manual.stocktake.id, rowVersion: headerChanged.stocktake.rowVersion,
      requestKey: randomUUID(), countDate: businessDateKey(), note: '新key不得跨日沿用旧日期', now: todayRange.endExclusive,
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId, id: manual.stocktake.id, rowVersion: headerChanged.stocktake.rowVersion,
      requestKey: randomUUID(), countDate: yesterday, note: '手工单不得回溯',
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(updateWarehouseStocktakeHeader({
      tenantId, userId, id: manual.stocktake.id, rowVersion: headerChanged.stocktake.rowVersion,
      requestKey: randomUUID(), countDate: tomorrow, note: '手工单不得未来',
    })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({
      tenantId, userId, id: manual.stocktake.id, rowVersion: headerChanged.stocktake.rowVersion, reason: '政策校验结束',
    })
    await upsertWarehouseStocktakeProductPolicy({
      tenantId, userId, warehouseId, productId: productIds[1], canCount: true, defaultIncluded: true,
      reason: null, rowVersion: 3, requestKey: randomUUID(),
    })
  })

  it('历史流水圈定拒绝回溯日期，日周月窗口遵循上海日界线', async () => {
    const today = businessDateKey()
    const previousDay = businessDateKey(new Date(businessDateOnlyRange(today).start.getTime() - 1))
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: previousDay, countScope: 'SELECTED', selectionRule: 'HISTORICAL_MOVEMENT',
    })).rejects.toMatchObject({ statusCode: 400 })
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: previousDay, countScope: 'SELECTED', selectionRule: 'MANUAL_SELECTED', manualProductIds: [productIds[0]],
    })).rejects.toMatchObject({ statusCode: 400 })
    const tomorrow = businessDateKey(new Date(businessDateOnlyRange(today).endExclusive.getTime() + 1))
    await expect(previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: tomorrow, countScope: 'ALL',
    })).rejects.toMatchObject({ statusCode: 400 })

    const daily = await previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'DAILY',
    })
    expect(daily.selectionRule).toBe('PERIOD_MOVEMENT_OR_OPENING')
    expect(daily.periodUnit).toBe('DAY')
    expect(daily.products.map(row => row.id).sort()).toEqual(productIds.sort())
    const monthly = await previewWarehouseStocktakeSelection({
      tenantId, warehouseId, countDate: today, countScope: 'SELECTED', selectionRule: 'PERIOD_MOVEMENT_OR_OPENING', periodUnit: 'MONTH',
    })
    expect(monthly.periodUnit).toBe('MONTH')
    expect(monthly.windowEndExclusive.toISOString()).toBe(businessDateOnlyRange(today).endExclusive.toISOString())
  })

  it('真实PG约束拒绝禁盘空原因与非期间规则残留window', async () => {
    await expect(prisma.$executeRaw(Prisma.sql`
      INSERT INTO "warehouse_stocktake_product_policies"
        ("id", "tenantId", "warehouseId", "productId", "canCount", "defaultIncluded", "reason", "rowVersion", "updatedById", "updatedAt")
      VALUES
        (${randomUUID()}, ${tenantId}, ${warehouseId}, ${productIds[0]}, false, true, NULL, 1, ${userId}, NOW())
    `)).rejects.toBeTruthy()

    const manual = await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: businessDateKey(), requestKey: randomUUID(),
      sections: [{ name: '约束盘点', assignedToId: userId, productIds: [productIds[0]] }],
    })
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "selectionWindowStart" = NOW()
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)).rejects.toBeTruthy()
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "planNoSnapshot" = 'INVALID-ORPHAN'
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)).rejects.toBeTruthy()
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "selectionFingerprint" = ${'g'.repeat(64)}
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)).rejects.toBeTruthy()
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "countScope" = 'ALL'
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)).rejects.toBeTruthy()
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "selectionRuleSnapshot" = 'FIXED_PLAN_PRODUCTS'
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)).rejects.toBeTruthy()
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "warehouse_stocktakes"
      SET "countScope" = 'ALL',
          "selectionRuleSnapshot" = NULL,
          "selectionPeriodUnitSnapshot" = NULL,
          "selectionWindowStart" = NULL,
          "selectionWindowEndExclusive" = NULL,
          "selectionFingerprint" = NULL
      WHERE "tenantId" = ${tenantId} AND "id" = ${manual.stocktake.id}
    `)
    await expect(addWarehouseStocktakeItems({
      tenantId, userId, id: manual.stocktake.id, rowVersion: manual.stocktake.rowVersion,
      requestKey: randomUUID(), sectionId: manual.stocktake.sections[0].id, productIds: [productIds[1]],
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect(removeWarehouseStocktakeItems({
      tenantId, userId, id: manual.stocktake.id, rowVersion: manual.stocktake.rowVersion,
      requestKey: randomUUID(), itemIds: [manual.stocktake.sections[0].items[0].id],
    })).rejects.toMatchObject({ statusCode: 409 })
    await cancelWarehouseStocktake({
      tenantId, userId, id: manual.stocktake.id, rowVersion: manual.stocktake.rowVersion, reason: '约束测试结束',
    })
  })

  it('任何圈定规则都拒绝仓库存在未来生效的physicalDelta流水', async () => {
    const movement = await prisma.warehouseLedgerMovement.findFirstOrThrow({
      where: { tenantId, warehouseId, productId: productIds[0], physicalDelta: { not: 0 } },
      orderBy: { effectiveAt: 'asc' },
    })
    const futureEffectiveAt = new Date(businessDateOnlyRange(businessDateKey()).endExclusive.getTime() + 60_000)
    await prisma.warehouseLedgerMovement.update({ where: { id: movement.id }, data: { effectiveAt: futureEffectiveAt } })
    try {
      await expect(previewWarehouseStocktakeSelection({
        tenantId,
        warehouseId,
        countDate: businessDateKey(),
        countScope: 'SELECTED',
        selectionRule: 'MANUAL_SELECTED',
        manualProductIds: [productIds[0]],
      })).rejects.toMatchObject({ statusCode: 409, code: 'STOCKTAKE_SELECTION_FUTURE_MOVEMENT' })
      await expect(previewWarehouseStocktakeSelection({
        tenantId, warehouseId, countDate: businessDateKey(), countScope: 'ALL',
      })).rejects.toMatchObject({ statusCode: 409, code: 'STOCKTAKE_SELECTION_FUTURE_MOVEMENT' })
    } finally {
      await prisma.warehouseLedgerMovement.update({ where: { id: movement.id }, data: { effectiveAt: movement.effectiveAt } })
    }
  })

  it('库位与添加来源由服务端冻结，单据日志租户隔离且可稳定分页，Excel只导出库存单位', async () => {
    const today = businessDateKey()
    let manual = (await createWarehouseStocktake({
      tenantId, userId, warehouseId, countDate: today, requestKey: randomUUID(),
      sections: [{ name: '来源与库位', assignedToId: userId, productIds: [productIds[0]] }],
    })).stocktake
    expect(manual.sections[0].items[0]).toMatchObject({ storageLocationSnapshot: 'A-01', additionSource: 'MANUAL' })
    await prisma.product.update({ where: { id: productIds[0] }, data: { location: 'Z-99' } })
    manual = (await addWarehouseStocktakeItems({
      tenantId, userId, id: manual.id, rowVersion: manual.rowVersion, requestKey: randomUUID(),
      sectionId: manual.sections[0].id, productIds: [productIds[1]],
    })).stocktake
    expect(manual.sections[0].items.find(item => item.productId === productIds[0])?.storageLocationSnapshot).toBe('A-01')
    expect(manual.sections[0].items.find(item => item.productId === productIds[1])).toMatchObject({ storageLocationSnapshot: 'A-02', additionSource: 'MANUAL' })

    const section = manual.sections[0]
    manual = await saveWarehouseStocktakeSection({
      tenantId, userId, stocktakeId: manual.id, sectionId: section.id, rowVersion: section.rowVersion, submit: true,
      items: section.items.map(item => ({ itemId: item.id, countedQuantity: item.bookQuantity.toString(), reason: null })),
    })
    manual = await submitWarehouseStocktake({ tenantId, userId, id: manual.id, rowVersion: manual.rowVersion })
    const actions = (await listWarehouseStocktakeLogs(tenantId, manual.id)).items.map(item => item.action)
    expect(actions).toEqual(expect.arrayContaining(['新建总仓盘点单', '提交盘点分区', '提交总仓盘点单审核']))

    await prisma.opLog.create({ data: {
      tenantId, userId: otherUserId, entityType: 'WarehouseStocktake', targetId: manual.id, target: manual.no, action: '跨租户伪造演员',
    } })
    await prisma.opLog.createMany({ data: Array.from({ length: 205 }, (_, index) => ({
      tenantId, entityType: 'WarehouseStocktake', targetId: manual.id, target: manual.no, action: `分页日志${index}`,
    })) })
    const firstPage = await listWarehouseStocktakeLogs(tenantId, manual.id)
    expect(firstPage.items).toHaveLength(200)
    expect(firstPage.hasMore).toBe(true)
    const secondPage = await listWarehouseStocktakeLogs(tenantId, manual.id, firstPage.nextCursor!)
    expect(secondPage.items.length).toBeGreaterThan(0)
    expect(new Set([...firstPage.items, ...secondPage.items].map(item => item.id)).size).toBe(firstPage.items.length + secondPage.items.length)
    const forged = [...firstPage.items, ...secondPage.items].find(item => item.action === '跨租户伪造演员')
    expect(forged).toMatchObject({ actor: '—', actorId: null })

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await buildWarehouseStocktakeWorkbook(await getWarehouseStocktake(tenantId, manual.id)) as any)
    const itemSheet = workbook.getWorksheet('盘点明细')!
    const headers = itemSheet.getRow(1).values as any[]
    expect(headers).toEqual(expect.arrayContaining(['库位', '添加方式', '库存单位']))
    expect(headers.some(value => String(value).includes('辅助单位'))).toBe(false)
    expect(itemSheet.getRow(2).getCell(headers.indexOf('库位')).value).toBe('A-01')
    expect(itemSheet.getRow(2).getCell(headers.indexOf('添加方式')).value).toBe('手工添加')

    const rejected = await rejectWarehouseStocktake({
      tenantId, userId, id: manual.id, rowVersion: manual.rowVersion, requestKey: randomUUID(), reason: '测试结束退回',
    })
    await cancelWarehouseStocktake({ tenantId, userId, id: manual.id, rowVersion: rejected.stocktake.rowVersion, reason: '来源日志测试结束' })
    await prisma.product.update({ where: { id: productIds[0] }, data: { location: 'A-01' } })
  })
})
