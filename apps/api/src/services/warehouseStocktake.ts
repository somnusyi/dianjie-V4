import { randomUUID } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { resolveProductFourUnits } from './inventoryUnits'
import { postWarehouseStocktakeDifference } from './warehouseLedger'

const ZERO = new Prisma.Decimal(0)
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value)

export const WAREHOUSE_STOCKTAKE_WRITE_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER'] as const
export const WAREHOUSE_STOCKTAKE_AUDIT_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'FINANCE'] as const
export const WAREHOUSE_STOCKTAKE_READ_ROLES = [...new Set([...WAREHOUSE_STOCKTAKE_WRITE_ROLES, ...WAREHOUSE_STOCKTAKE_AUDIT_ROLES])]

const detailInclude = {
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  sections: {
    include: {
      assignedTo: { select: { id: true, name: true } },
      items: { include: { entry: true }, orderBy: { sortOrder: 'asc' as const } },
    },
    orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }],
  },
  adjustments: { include: { lines: true }, orderBy: { type: 'asc' as const } },
} satisfies Prisma.WarehouseStocktakeInclude

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      })
    } catch (error: any) {
      const serializationConflict = error?.code === 'P2010' && String(error?.meta?.code || '') === '40001'
      const uniqueTarget = Array.isArray(error?.meta?.target) ? error.meta.target.map(String) : []
      if (error?.code === 'P2002' && uniqueTarget.includes('warehouseId')) {
        throw fail('该仓库已有进行中的盘点单，请先完成或取消后再新建', 409)
      }
      if ((!['P2002', 'P2034'].includes(error?.code) && !serializationConflict) || attempt === 5) throw error
    }
  }
  throw fail('盘点单并发更新失败，请重试')
}

async function lockStocktake(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "warehouse_stocktakes"
    WHERE "tenantId" = ${tenantId} AND "id" = ${id}
    FOR UPDATE
  `)
  if (!rows.length) throw fail('总仓盘点单不存在', 404)
  return tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId, id }, include: detailInclude })
}

export async function getWarehouseStocktake(tenantId: string, id: string) {
  const row = await prisma.warehouseStocktake.findFirst({ where: { tenantId, id }, include: detailInclude })
  if (!row) throw fail('总仓盘点单不存在', 404)
  return row
}

export async function listWarehouseStocktakes(input: {
  tenantId: string
  status?: 'DRAFT' | 'COUNTING' | 'REVIEWING' | 'CONFIRMED' | 'CANCELLED'
  warehouseId?: string
  q?: string
  page: number
  pageSize: number
}) {
  const where: Prisma.WarehouseStocktakeWhereInput = {
    tenantId: input.tenantId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    ...(input.q ? { OR: [{ no: { contains: input.q, mode: 'insensitive' } }, { note: { contains: input.q, mode: 'insensitive' } }] } : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.warehouseStocktake.count({ where }),
    prisma.warehouseStocktake.findMany({
      where,
      include: { warehouse: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: [{ countDate: 'desc' }, { createdAt: 'desc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ])
  return { rows, total, page: input.page, pageSize: input.pageSize }
}

export async function warehouseStocktakeOptions(tenantId: string) {
  const [warehouses, products, users] = await Promise.all([
    prisma.warehouse.findMany({ where: { tenantId, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.product.findMany({
      where: { tenantId, status: 'ENABLED', unitConversionStatus: 'VERIFIED' },
      select: { id: true, code: true, name: true, spec: true, category: true, unit: true, inventoryUnit: true },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    }),
    prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: { in: [...WAREHOUSE_STOCKTAKE_WRITE_ROLES] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
  ])
  return { warehouses, products, users }
}

type CreateInput = {
  tenantId: string
  userId: string
  requestKey: string
  warehouseId: string
  countDate: string
  note?: string | null
  sections: Array<{ name: string; assignedToId: string; productIds: string[] }>
}

export async function createWarehouseStocktake(input: CreateInput) {
  return serializable(async tx => {
    const replay = await tx.warehouseStocktake.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
      include: detailInclude,
    })
    if (replay) {
      const expected = input.sections.map(section => ({
        name: section.name.trim(), assignedToId: section.assignedToId, productIds: [...section.productIds].sort(),
      })).sort((a, b) => a.name.localeCompare(b.name))
      const actual = replay.sections.map(section => ({
        name: section.name, assignedToId: section.assignedToId, productIds: section.items.map(item => item.productId).sort(),
      })).sort((a, b) => a.name.localeCompare(b.name))
      const sameRequest = replay.warehouseId === input.warehouseId
        && replay.countDate.toISOString().slice(0, 10) === input.countDate
        && (replay.note || null) === (input.note?.trim() || null)
        && JSON.stringify(actual) === JSON.stringify(expected)
      if (!sameRequest) throw fail('同一请求键不能用于不同的盘点单内容', 409)
      return { replayed: true, stocktake: replay }
    }
    const warehouse = await tx.warehouse.findFirst({ where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true } })
    if (!warehouse) throw fail('总仓不存在或不属于当前租户', 404)
    if (!input.sections.length) throw fail('至少需要一个盘点分区', 400)
    const names = input.sections.map(section => section.name.trim())
    if (names.some(name => !name) || new Set(names).size !== names.length) throw fail('分区名称不能为空或重复', 400)
    const productIds = input.sections.flatMap(section => section.productIds)
    if (!productIds.length || new Set(productIds).size !== productIds.length) throw fail('盘点商品不能为空或跨分区重复', 400)
    const assigneeIds = [...new Set(input.sections.map(section => section.assignedToId))]
    const users = await tx.user.findMany({
      where: { tenantId: input.tenantId, id: { in: assigneeIds }, status: 'ACTIVE', role: { in: [...WAREHOUSE_STOCKTAKE_WRITE_ROLES] } },
      select: { id: true },
    })
    if (users.length !== assigneeIds.length) throw fail('分区负责人必须是本租户启用中的供应链写入人员', 400)
    const products = await tx.product.findMany({
      where: { tenantId: input.tenantId, id: { in: productIds }, status: 'ENABLED', unitConversionStatus: 'VERIFIED' },
      select: {
        id: true, code: true, name: true, spec: true, category: true, unit: true, purchaseUnit: true, orderUnit: true,
        costUnit: true, inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
        inventoryUnitsPerCostUnit: true, unitConversionStatus: true,
      },
    })
    if (products.length !== productIds.length) throw fail('商品不存在、已停用或四单位换算未核验', 400)
    for (const product of products) {
      const unit = resolveProductFourUnits(product).inventoryUnit
      await tx.warehouseLedgerBalance.upsert({
        where: { tenantId_warehouseId_productId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id } },
        create: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id, inventoryUnit: unit },
        update: {},
      })
    }
    const balances = await tx.warehouseLedgerBalance.findMany({
      where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds } },
    })
    const productsById = new Map(products.map(product => [product.id, product]))
    const balancesByProduct = new Map(balances.map(balance => [balance.productId, balance]))
    const stocktake = await tx.warehouseStocktake.create({
      data: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        no: `WST-${input.countDate.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
        countDate: new Date(`${input.countDate}T00:00:00.000Z`),
        requestKey: input.requestKey,
        note: input.note?.trim() || null,
        createdById: input.userId,
        itemCount: productIds.length,
        totalBookValue: balances.reduce((sum, balance) => sum.plus(balance.inventoryValue), ZERO),
      },
    })
    let sortOrder = 0
    for (let sectionIndex = 0; sectionIndex < input.sections.length; sectionIndex += 1) {
      const sectionInput = input.sections[sectionIndex]
      const section = await tx.warehouseStocktakeSection.create({
        data: {
          tenantId: input.tenantId,
          stocktakeId: stocktake.id,
          name: names[sectionIndex],
          assignedToId: sectionInput.assignedToId,
        },
      })
      for (const productId of sectionInput.productIds) {
        const product = productsById.get(productId)!
        const balance = balancesByProduct.get(productId)!
        await tx.warehouseStocktakeItem.create({
          data: {
            tenantId: input.tenantId,
            stocktakeId: stocktake.id,
            sectionId: section.id,
            productId,
            productCodeSnapshot: product.code,
            productNameSnapshot: product.name,
            productSpecSnapshot: product.spec,
            categorySnapshot: product.category,
            inventoryUnit: balance.inventoryUnit,
            bookQuantity: balance.physicalQty,
            bookValue: balance.inventoryValue,
            averageUnitCost: balance.averageUnitCost,
            bookBalanceVersion: balance.rowVersion,
            sortOrder: sortOrder++,
          },
        })
      }
    }
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id }, include: detailInclude }) }
  })
}

export async function saveWarehouseStocktakeSection(input: {
  tenantId: string
  userId: string
  stocktakeId: string
  sectionId: string
  rowVersion: number
  submit: boolean
  items: Array<{ itemId: string; countedQuantity: string | number; countedUnitCost?: string | number | null; reason?: string | null }>
}) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.stocktakeId)
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('当前状态不能录入实盘', 409)
    const section = stocktake.sections.find(row => row.id === input.sectionId)
    if (!section) throw fail('盘点分区不存在', 404)
    if (section.assignedToId !== input.userId) throw fail('只能录入分配给自己的盘点分区', 403)
    if (section.status === 'SUBMITTED') throw fail('该分区已提交，请由审核人退回后再修改', 409)
    if (section.rowVersion !== input.rowVersion) throw fail('该分区已被更新，请刷新后重新录入', 409)
    if (new Set(input.items.map(item => item.itemId)).size !== input.items.length) throw fail('不能重复录入同一商品', 400)
    for (const entry of input.items) {
      const item = section.items.find(row => row.id === entry.itemId)
      if (!item) throw fail('录入商品不属于当前分区', 400)
      const countedQuantity = dec(entry.countedQuantity).toDecimalPlaces(6)
      if (!countedQuantity.isFinite() || countedQuantity.lt(0)) throw fail('实盘数量不能为负数', 400)
      const requestedCost = entry.countedUnitCost == null ? item.averageUnitCost : dec(entry.countedUnitCost).toDecimalPlaces(6)
      if (!requestedCost.isFinite() || requestedCost.lt(0) || (countedQuantity.gt(0) && requestedCost.lte(0))) throw fail('有实盘库存时单位成本必须大于0', 400)
      if (item.bookQuantity.gt(0) && !requestedCost.eq(item.averageUnitCost)) throw fail('已有账面库存必须沿用移动均价', 400)
      const countedValue = countedQuantity.mul(requestedCost).toDecimalPlaces(4)
      const differenceQuantity = countedQuantity.minus(item.bookQuantity).toDecimalPlaces(6)
      const differenceValue = countedValue.minus(item.bookValue).toDecimalPlaces(4)
      const reason = entry.reason?.trim() || null
      await tx.warehouseStocktakeEntry.upsert({
        where: { stocktakeItemId: item.id },
        create: {
          tenantId: input.tenantId, stocktakeId: stocktake.id, sectionId: section.id, stocktakeItemId: item.id,
          enteredById: input.userId, countedQuantity, countedUnitCost: requestedCost, note: reason,
        },
        update: { enteredById: input.userId, countedQuantity, countedUnitCost: requestedCost, note: reason, rowVersion: { increment: 1 }, savedAt: new Date() },
      })
      await tx.warehouseStocktakeItem.update({
        where: { id: item.id },
        data: { countedQuantity, countedUnitCost: requestedCost, countedValue, differenceQuantity, differenceValue, reason },
      })
    }
    const allEntries = await tx.warehouseStocktakeItem.findMany({ where: { tenantId: input.tenantId, stocktakeId: stocktake.id } })
    const sectionItems = allEntries.filter(item => item.sectionId === section.id)
    if (input.submit && sectionItems.some(item => item.countedQuantity == null)) throw fail('请完整录入分区内全部商品后再提交', 400)
    const changed = await tx.warehouseStocktakeSection.updateMany({
      where: { id: section.id, tenantId: input.tenantId, rowVersion: input.rowVersion, status: 'OPEN' },
      data: { rowVersion: { increment: 1 }, status: input.submit ? 'SUBMITTED' : 'OPEN', submittedAt: input.submit ? new Date() : null },
    })
    if (changed.count !== 1) throw fail('该分区已被更新，请刷新后重试', 409)
    const counted = allEntries.filter(item => item.countedQuantity != null)
    await tx.warehouseStocktake.update({
      where: { id: stocktake.id },
      data: {
        status: 'COUNTING', rowVersion: { increment: 1 }, countedCount: counted.length,
        differenceCount: counted.filter(item => !dec(item.differenceQuantity || 0).isZero()).length,
        totalCountedValue: counted.reduce((sum, item) => sum.plus(item.countedValue || 0), ZERO),
        totalDifferenceValue: counted.reduce((sum, item) => sum.plus(item.differenceValue || 0), ZERO),
      },
    })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id }, include: detailInclude })
  })
}

export async function submitWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion: number }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.status === 'REVIEWING') return stocktake
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('当前状态不能汇总提交', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已更新，请刷新后重试', 409)
    if (stocktake.sections.some(section => section.status !== 'SUBMITTED')) throw fail('请先完成并提交所有盘点分区', 400)
    const items = stocktake.sections.flatMap(section => section.items)
    if (!items.length || items.some(item => item.countedQuantity == null)) throw fail('实盘数据不完整', 400)
    const missingReason = items.find(item => !dec(item.differenceQuantity || 0).isZero() && !item.reason?.trim())
    if (missingReason) throw fail(`「${missingReason.productNameSnapshot}」存在差异，请填写盘盈/盘亏原因`, 400)
    const updated = await tx.warehouseStocktake.updateMany({
      where: { id: stocktake.id, tenantId: input.tenantId, rowVersion: input.rowVersion, status: { in: ['DRAFT', 'COUNTING'] } },
      data: { status: 'REVIEWING', submittedAt: new Date(), submittedById: input.userId, rowVersion: { increment: 1 }, reviewNote: null },
    })
    if (updated.count !== 1) throw fail('盘点单已被其他人提交', 409)
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id }, include: detailInclude })
  })
}

export async function rejectWarehouseStocktake(input: { tenantId: string; userId: string; id: string; reason: string }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.status !== 'REVIEWING') throw fail('只有待审核盘点单可以退回', 409)
    await tx.warehouseStocktakeSection.updateMany({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id },
      data: { status: 'OPEN', submittedAt: null, rowVersion: { increment: 1 } },
    })
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: '退回总仓盘点', entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no, metadata: { reason: input.reason } } })
    return tx.warehouseStocktake.update({
      where: { id: stocktake.id },
      data: { status: 'COUNTING', submittedAt: null, submittedById: null, reviewNote: input.reason, rowVersion: { increment: 1 } },
    })
  })
}

export async function cancelWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion: number; reason: string }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('只有草稿或盘点中单据可以取消', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后再取消', 409)
    const updated = await tx.warehouseStocktake.updateMany({
      where: { id: stocktake.id, tenantId: input.tenantId, rowVersion: input.rowVersion, status: { in: ['DRAFT', 'COUNTING'] } },
      data: { status: 'CANCELLED', reviewNote: input.reason, rowVersion: { increment: 1 } },
    })
    if (updated.count !== 1) throw fail('盘点单已被更新，请刷新后再取消', 409)
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: '取消总仓盘点', entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no, metadata: { reason: input.reason } } })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id, tenantId: input.tenantId } })
  })
}

export async function approveWarehouseStocktake(input: { tenantId: string; userId: string; id: string }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.status === 'CONFIRMED') return { replayed: true, stocktake }
    if (stocktake.status !== 'REVIEWING') throw fail('只有待审核盘点单可以审核', 409)
    const items = stocktake.sections.flatMap(section => section.items).sort((a, b) => a.productId.localeCompare(b.productId))
    const productIds = items.map(item => item.productId)
    const balances = productIds.length ? await tx.$queryRaw<Array<{
      productId: string; physicalQty: Prisma.Decimal; reservedQty: Prisma.Decimal; inventoryValue: Prisma.Decimal; rowVersion: number
    }>>(Prisma.sql`
      SELECT "productId", "physicalQty", "reservedQty", "inventoryValue", "rowVersion"
      FROM "warehouse_ledger_balances"
      WHERE "tenantId" = ${input.tenantId} AND "warehouseId" = ${stocktake.warehouseId}
        AND "productId" IN (${Prisma.join(productIds)})
      ORDER BY "productId" FOR UPDATE
    `) : []
    const balanceByProduct = new Map(balances.map(balance => [balance.productId, balance]))
    for (const item of items) {
      const balance = balanceByProduct.get(item.productId)
      if (!balance || balance.rowVersion !== item.bookBalanceVersion || !balance.physicalQty.eq(item.bookQuantity) || !balance.inventoryValue.eq(item.bookValue)) {
        throw fail(`盘点期间「${item.productNameSnapshot}」库存已变动，请退回并重新发起`, 409)
      }
      if (item.countedQuantity == null || item.countedUnitCost == null || item.differenceQuantity == null) throw fail('实盘数据不完整', 400)
      if (item.countedQuantity.lt(balance.reservedQty)) throw fail(`「${item.productNameSnapshot}」实盘数量低于活动预占`, 409)
    }
    const effectiveAt = new Date()
    const grouped = {
      PROFIT: items.filter(item => dec(item.differenceQuantity || 0).gt(0)),
      LOSS: items.filter(item => dec(item.differenceQuantity || 0).lt(0)),
    }
    for (const type of ['PROFIT', 'LOSS'] as const) {
      const selected = grouped[type]
      if (!selected.length) continue
      const adjustment = await tx.warehouseStocktakeAdjustment.upsert({
        where: { stocktakeId_type: { stocktakeId: stocktake.id, type } },
        create: {
          tenantId: input.tenantId, stocktakeId: stocktake.id, type,
          no: `${stocktake.no}-${type === 'PROFIT' ? 'PY' : 'PK'}`,
          itemCount: selected.length,
          totalAmount: selected.reduce((sum, item) => sum.plus(dec(item.differenceValue || 0).abs()), ZERO),
        },
        update: {},
      })
      for (const item of selected) {
        const result = await postWarehouseStocktakeDifference(tx, {
          tenantId: input.tenantId,
          warehouseId: stocktake.warehouseId,
          stocktakeId: stocktake.id,
          stocktakeItemId: item.id,
          userId: input.userId,
          productId: item.productId,
          productName: item.productNameSnapshot,
          inventoryUnit: item.inventoryUnit,
          expectedBookVersion: item.bookBalanceVersion,
          differenceQuantity: item.differenceQuantity!,
          unitCost: item.countedUnitCost!,
          effectiveAt,
          reason: item.reason || (type === 'PROFIT' ? '总仓盘盈' : '总仓盘亏'),
        })
        await tx.warehouseStocktakeAdjustmentLine.upsert({
          where: { adjustmentId_stocktakeItemId: { adjustmentId: adjustment.id, stocktakeItemId: item.id } },
          create: {
            tenantId: input.tenantId, adjustmentId: adjustment.id, stocktakeItemId: item.id, productId: item.productId,
            quantity: dec(item.differenceQuantity!).abs(), inventoryUnit: item.inventoryUnit,
            unitCost: item.countedUnitCost!, amount: dec(item.differenceValue || 0).abs(), movementId: result.movement.id,
          },
          update: {},
        })
      }
    }
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: '审核总仓盘点并生成盘盈盘亏', entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no } })
    const updated = await tx.warehouseStocktake.update({
      where: { id: stocktake.id },
      data: { status: 'CONFIRMED', reviewedAt: effectiveAt, reviewedById: input.userId, reviewNote: null, rowVersion: { increment: 1 } },
    })
    return { replayed: false, stocktake: updated }
  })
}
