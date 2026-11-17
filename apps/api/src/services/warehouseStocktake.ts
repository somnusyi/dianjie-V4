import { createHash, randomUUID } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { supplyChainProductScope } from '../lib/supply-chain-product-scope'
import { businessDateKey } from '../lib/businessTime'
import { resolveProductFourUnits } from './inventoryUnits'
import { postWarehouseStocktakeDifference, reverseWarehouseStocktakeCycleInTransaction } from './warehouseLedger'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from './warehouseStocktakeConstants'
import {
  resolveWarehouseStocktakeSelection,
  type WarehouseStocktakeCountScope,
  type WarehouseStocktakeSelectionRule,
} from './warehouseStocktakeSelection'

const ZERO = new Prisma.Decimal(0)
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value)
const preApprovalActions = ['WITHDRAW', 'REJECT', 'HEADER_EDIT', 'ITEM_ADD', 'ITEM_REMOVE', 'ITEM_REORDER', 'DELETE'] as const
type PreApprovalAction = typeof preApprovalActions[number]

export const WAREHOUSE_STOCKTAKE_WRITE_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER'] as const
export const WAREHOUSE_STOCKTAKE_AUDIT_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN'] as const
export const WAREHOUSE_STOCKTAKE_READ_ROLES = [...new Set([...WAREHOUSE_STOCKTAKE_WRITE_ROLES, ...WAREHOUSE_STOCKTAKE_AUDIT_ROLES, 'FINANCE'])]

const detailInclude = {
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  auditedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  sections: {
    include: {
      assignedTo: { select: { id: true, name: true } },
      items: { include: { entry: true }, orderBy: { sortOrder: 'asc' as const } },
    },
    orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }],
  },
  adjustments: { include: { lines: true }, orderBy: [{ cycle: 'desc' as const }, { type: 'asc' as const }] },
  mergeSources: { select: { sourceStocktakeId: true, formalStocktakeId: true } },
  generatedFrom: { select: { sourceStocktakeId: true, formalStocktakeId: true } },
} satisfies Prisma.WarehouseStocktakeInclude

const stocktakeProductSelect = {
  id: true, code: true, name: true, spec: true, category: true, unit: true, purchaseUnit: true, orderUnit: true,
  costUnit: true, inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
  inventoryUnitsPerCostUnit: true, unitConversionStatus: true, location: true,
} satisfies Prisma.ProductSelect

type StocktakeProduct = Prisma.ProductGetPayload<{ select: typeof stocktakeProductSelect }>
type StocktakeBalance = Prisma.WarehouseLedgerBalanceGetPayload<Record<string, never>>

const stocktakeProductScope = (tenantId: string): Prisma.ProductWhereInput => ({
  tenantId,
  status: 'ENABLED',
  ...supplyChainProductScope(tenantId),
})

function lifecycleFingerprint(action: PreApprovalAction, stocktakeId: string, rowVersion: number, payload: unknown) {
  return createHash('sha256').update(JSON.stringify({ action, stocktakeId, rowVersion, payload })).digest('hex')
}

function assertLifecycleRequest(requestKey: string, rowVersion: number) {
  if (!requestKey || requestKey.length < 8 || requestKey.length > 160) throw fail('盘点操作请求编号无效', 400)
  if (!Number.isSafeInteger(rowVersion) || rowVersion < 0) throw fail('盘点单版本无效', 400)
}

async function lifecycleReplay(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; id: string; requestKey: string },
  action: PreApprovalAction,
  requestFingerprint: string,
) {
  const replay = await tx.warehouseStocktakeLifecycleEvent.findUnique({
    where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
  })
  if (!replay) return null
  if (replay.action !== action || replay.stocktakeId !== input.id || replay.requestFingerprint !== requestFingerprint) {
    throw fail('同一请求编号不能用于不同的盘点操作', 409)
  }
  return {
    replayed: true,
    stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: input.id, deletedAt: null }, include: detailInclude }),
  }
}

function hasGenerationRelation(stocktake: Prisma.WarehouseStocktakeGetPayload<{ include: typeof detailInclude }>) {
  return Boolean(
    stocktake.sourceMultiId
    || stocktake.generatedStocktakeId
    || stocktake.mergeSources.length
    || stocktake.generatedFrom.length,
  )
}

function hasFrozenSelection(stocktake: Prisma.WarehouseStocktakeGetPayload<{ include: typeof detailInclude }>) {
  return Boolean(
    stocktake.countScope === 'ALL'
    || stocktake.planId
    || (stocktake.selectionRuleSnapshot && stocktake.selectionRuleSnapshot !== 'MANUAL_SELECTED'),
  )
}

async function assertNoPostingEvidence(
  tx: Prisma.TransactionClient,
  stocktake: Prisma.WarehouseStocktakeGetPayload<{ include: typeof detailInclude }>,
) {
  if (stocktake.postingCycle > 0 || stocktake.adjustments.length) throw fail('该盘点单已有过账证据，不能修改盘点范围', 409)
  const postingEvent = await tx.warehouseStocktakeLifecycleEvent.findFirst({
    where: { tenantId: stocktake.tenantId, stocktakeId: stocktake.id, action: { in: ['APPROVE', 'REVERSE_APPROVAL'] } },
    select: { id: true },
  })
  if (postingEvent) throw fail('该盘点单已有审核或反审核证据，不能修改盘点范围', 409)
}

async function assertCreatorOrAdministrator(
  tx: Prisma.TransactionClient,
  stocktake: { tenantId: string; createdById: string },
  userId: string,
) {
  if (stocktake.createdById === userId) return
  const actor = await tx.user.findFirst({ where: { tenantId: stocktake.tenantId, id: userId, status: 'ACTIVE' }, select: { role: true } })
  if (!actor || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw fail('只能由盘点单创建人或管理员修改', 403)
}

async function assertAuditActor(tx: Prisma.TransactionClient, tenantId: string, userId: string) {
  const actor = await tx.user.findFirst({ where: { tenantId, id: userId, status: 'ACTIVE' }, select: { role: true } })
  if (!actor || !(WAREHOUSE_STOCKTAKE_AUDIT_ROLES as readonly string[]).includes(actor.role)) throw fail('只能由盘点审核人员驳回', 403)
}

async function loadWarehouseStocktakeProducts(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; warehouseId: string; productIds: string[] },
) {
  const products = await tx.product.findMany({
    where: { ...stocktakeProductScope(input.tenantId), id: { in: input.productIds } },
    select: stocktakeProductSelect,
  })
  if (products.length !== input.productIds.length) throw fail('商品不在总仓盘点范围内或已停用', 400)
  for (const product of products) {
    if (product.unitConversionStatus !== 'VERIFIED') continue
    const inventoryUnit = resolveProductFourUnits(product).inventoryUnit
    await tx.warehouseLedgerBalance.upsert({
      where: { tenantId_warehouseId_productId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id } },
      create: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id, inventoryUnit },
      update: {},
    })
  }
  const balances = await tx.warehouseLedgerBalance.findMany({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: input.productIds } },
  })
  return {
    products,
    balances,
    productsById: new Map(products.map(product => [product.id, product])),
    balancesByProduct: new Map(balances.map(balance => [balance.productId, balance])),
  }
}

function warehouseStocktakeItemData(input: {
  tenantId: string
  stocktakeId: string
  sectionId: string
  product: StocktakeProduct
  balance?: StocktakeBalance
  sortOrder: number
  additionSource: 'SYSTEM' | 'PLAN' | 'RECOUNT' | 'MANUAL' | 'MERGED'
}): Prisma.WarehouseStocktakeItemUncheckedCreateInput {
  const { product, balance } = input
  return {
    tenantId: input.tenantId,
    stocktakeId: input.stocktakeId,
    sectionId: input.sectionId,
    productId: product.id,
    productCodeSnapshot: product.code,
    productNameSnapshot: product.name,
    productSpecSnapshot: product.spec,
    categorySnapshot: product.category,
    storageLocationSnapshot: product.location,
    additionSource: input.additionSource,
    inventoryUnit: balance?.inventoryUnit || product.inventoryUnit || product.unit || '待核验',
    unitPending: product.unitConversionStatus !== 'VERIFIED',
    bookQuantity: balance?.physicalQty || ZERO,
    bookValue: balance?.inventoryValue || ZERO,
    averageUnitCost: balance?.averageUnitCost || ZERO,
    bookBalanceVersion: balance?.rowVersion || 0,
    sortOrder: input.sortOrder,
  }
}

async function recalculateWarehouseStocktake(
  tx: Prisma.TransactionClient,
  tenantId: string,
  stocktakeId: string,
) {
  const items = await tx.warehouseStocktakeItem.findMany({ where: { tenantId, stocktakeId } })
  const counted = items.filter(item => item.countedQuantity != null)
  await tx.warehouseStocktake.update({
    where: { id: stocktakeId, tenantId, deletedAt: null },
    data: {
      itemCount: items.length,
      countedCount: counted.length,
      differenceCount: counted.filter(item => !dec(item.differenceQuantity || 0).isZero()).length,
      totalBookValue: items.reduce((sum, item) => sum.plus(item.bookValue), ZERO).toDecimalPlaces(4),
      totalCountedValue: counted.reduce((sum, item) => sum.plus(item.countedValue || 0), ZERO).toDecimalPlaces(4),
      totalDifferenceValue: counted.reduce((sum, item) => sum.plus(item.differenceValue || 0), ZERO).toDecimalPlaces(4),
      rowVersion: { increment: 1 },
    },
  })
}

async function createPreApprovalLifecycleEvent(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    stocktakeId: string
    action: PreApprovalAction
    requestKey: string
    requestFingerprint: string
    actorId: string
    reason?: string | null
    fromStatus: 'DRAFT' | 'COUNTING' | 'REVIEWING' | 'CONFIRMED' | 'CANCELLED'
    toStatus: 'DRAFT' | 'COUNTING' | 'REVIEWING' | 'CONFIRMED' | 'CANCELLED'
    fromReviewStatus: 'UNREVIEWED' | 'REVIEWED'
    toReviewStatus: 'UNREVIEWED' | 'REVIEWED'
    metadata?: Prisma.InputJsonValue
  },
) {
  if (!preApprovalActions.includes(input.action)) throw fail('审核前盘点动作无效', 500)
  return tx.warehouseStocktakeLifecycleEvent.create({ data: {
    tenantId: input.tenantId,
    stocktakeId: input.stocktakeId,
    cycle: 0,
    action: input.action,
    requestKey: input.requestKey,
    requestFingerprint: input.requestFingerprint,
    actorId: input.actorId,
    reason: input.reason?.trim() || null,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    fromReviewStatus: input.fromReviewStatus,
    toReviewStatus: input.toReviewStatus,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  } })
}

async function assertPreApprovalEditable(
  tx: Prisma.TransactionClient,
  stocktake: Prisma.WarehouseStocktakeGetPayload<{ include: typeof detailInclude }>,
) {
  if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('只有草稿或盘点中单据可以修改', 409)
  if (stocktake.reviewStatus !== 'UNREVIEWED') throw fail('已复审盘点单不能修改', 409)
  if (hasGenerationRelation(stocktake)) throw fail('该盘点单已汇总或由多人盘点生成，不能修改', 409)
  await assertNoPostingEvidence(tx, stocktake)
}

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
    WHERE "tenantId" = ${tenantId} AND "id" = ${id} AND "deletedAt" IS NULL
    FOR UPDATE
  `)
  if (!rows.length) throw fail('总仓盘点单不存在', 404)
  return tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId, id, deletedAt: null }, include: detailInclude })
}

export async function getWarehouseStocktake(tenantId: string, id: string) {
  const row = await prisma.warehouseStocktake.findFirst({ where: { tenantId, id, deletedAt: null }, include: detailInclude })
  if (!row) throw fail('总仓盘点单不存在', 404)
  return row
}

export async function listWarehouseStocktakes(input: {
  tenantId: string
  status?: 'DRAFT' | 'COUNTING' | 'REVIEWING' | 'CONFIRMED' | 'CANCELLED'
  documentType?: 'LEGACY' | 'MULTI' | 'FORMAL'
  warehouseId?: string
  q?: string
  page: number
  pageSize: number
}) {
  const where: Prisma.WarehouseStocktakeWhereInput = {
    tenantId: input.tenantId,
    deletedAt: null,
    ...(input.status ? { status: input.status } : {}),
    ...(input.documentType ? { documentType: input.documentType } : {}),
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    ...(input.q ? { OR: [{ no: { contains: input.q, mode: 'insensitive' } }, { note: { contains: input.q, mode: 'insensitive' } }] } : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.warehouseStocktake.count({ where }),
    prisma.warehouseStocktake.findMany({
      where,
      include: {
        warehouse: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        submittedBy: { select: { id: true, name: true } },
        auditedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ countDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ])
  return { rows, total, page: input.page, pageSize: input.pageSize }
}

export async function warehouseStocktakeOptions(tenantId: string) {
  const [warehouses, products, users, plans] = await Promise.all([
    prisma.warehouse.findMany({ where: { tenantId, isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.product.findMany({
      where: { tenantId, status: 'ENABLED', ...supplyChainProductScope(tenantId) },
      select: { id: true, code: true, name: true, spec: true, category: true, unit: true, inventoryUnit: true, unitConversionStatus: true },
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
    }),
    prisma.user.findMany({
      where: { tenantId, status: 'ACTIVE', role: { in: [...WAREHOUSE_STOCKTAKE_WRITE_ROLES] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.warehouseStocktakePlan.findMany({
      where: { tenantId, status: 'ENABLED' },
      select: {
        id: true, no: true, name: true, warehouseId: true, countScope: true,
        selectionRule: true, periodUnit: true, rowVersion: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    }),
  ])
  return { warehouses, products, users, plans }
}

export async function listWarehouseStocktakeLogs(tenantId: string, id: string, cursor?: string) {
  const stocktake = await prisma.warehouseStocktake.findFirst({ where: { tenantId, id, deletedAt: null }, select: { id: true } })
  if (!stocktake) throw fail('总仓盘点单不存在', 404)
  let before: { createdAt: Date; id: string } | null = null
  if (cursor) {
    const separator = cursor.indexOf('|')
    const createdAt = new Date(separator > 0 ? cursor.slice(0, separator) : '')
    const cursorId = separator > 0 ? cursor.slice(separator + 1) : ''
    if (!cursorId || cursorId.length > 64 || Number.isNaN(createdAt.getTime())) throw fail('操作日志游标无效', 400)
    before = { createdAt, id: cursorId }
  }
  const rows = await prisma.opLog.findMany({
    where: {
      tenantId, entityType: 'WarehouseStocktake', targetId: id,
      ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 201,
    select: { id: true, action: true, target: true, targetId: true, metadata: true, createdAt: true, userId: true },
  })
  const hasMore = rows.length > 200
  const page = rows.slice(0, 200)
  const actorIds = [...new Set(page.flatMap(row => row.userId ? [row.userId] : []))]
  const actors = actorIds.length ? await prisma.user.findMany({
    where: { tenantId, id: { in: actorIds } }, select: { id: true, name: true },
  }) : []
  const actorNames = new Map(actors.map(actor => [actor.id, actor.name]))
  const last = page.at(-1)
  return { items: page.map(row => ({
    id: row.id, action: row.action, no: row.target, targetId: row.targetId,
    createdAt: row.createdAt, actor: row.userId ? actorNames.get(row.userId) || '—' : '—',
    actorId: row.userId && actorNames.has(row.userId) ? row.userId : null, metadata: row.metadata,
  })), hasMore, nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null }
}

type CreateInput = {
  tenantId: string
  userId: string
  requestKey: string
  warehouseId: string
  countDate: string
  countScope?: WarehouseStocktakeCountScope
  planId?: string | null
  selectionRule?: WarehouseStocktakeSelectionRule | null
  periodUnit?: 'DAY' | 'WEEK' | 'MONTH' | null
  selectionFingerprint?: string | null
  documentType?: 'MULTI' | 'FORMAL'
  note?: string | null
  sections: Array<{ name: string; assignedToId: string; productIds: string[] }>
}

export async function createWarehouseStocktake(input: CreateInput) {
  return serializable(async tx => {
    const expectedDocumentType = input.documentType ?? 'LEGACY'
    const expectedCountScope = input.countScope ?? 'SELECTED'
    const replay = await tx.warehouseStocktake.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
      include: detailInclude,
    })
    if (replay) {
      if (replay.deletedAt) throw fail('原创建请求对应的盘点单已删除，不能返回或重建', 409)
      if ((input.planId || replay.selectionRuleSnapshot !== 'MANUAL_SELECTED') && !input.selectionFingerprint) {
        throw fail('方案或自动圈定创建前必须先预览并提交圈定指纹', 400)
      }
      const expected = input.sections.map(section => ({
        name: section.name.trim(), assignedToId: section.assignedToId, productIds: [...section.productIds].sort(),
      })).sort((a, b) => a.name.localeCompare(b.name))
      const actual = replay.sections.map(section => ({
        name: section.name, assignedToId: section.assignedToId, productIds: section.items.map(item => item.productId).sort(),
      })).sort((a, b) => a.name.localeCompare(b.name))
      const sameRequest = replay.warehouseId === input.warehouseId
        && replay.documentType === expectedDocumentType
        && replay.countDate.toISOString().slice(0, 10) === input.countDate
        && (replay.note || null) === (input.note?.trim() || null)
        && replay.countScope === expectedCountScope
        && (replay.planId || null) === (input.planId || null)
        && (!input.selectionRule || replay.selectionRuleSnapshot === input.selectionRule)
        && (!input.periodUnit || replay.selectionPeriodUnitSnapshot === input.periodUnit)
        && (!input.selectionFingerprint || replay.selectionFingerprint === input.selectionFingerprint)
        && JSON.stringify(actual) === JSON.stringify(expected)
      if (!sameRequest) throw fail('同一请求键不能用于不同的盘点单内容', 409)
      return { replayed: true, stocktake: replay }
    }
    const warehouse = await tx.warehouse.findFirst({ where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true } })
    if (!warehouse) throw fail('总仓不存在或不属于当前租户', 404)
    const active = input.documentType === 'MULTI' ? null : await tx.warehouseStocktake.findFirst({
      where: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        documentType: { not: 'MULTI' },
        deletedAt: null,
        status: { in: ['DRAFT', 'COUNTING', 'REVIEWING'] },
      },
      select: { id: true },
    })
    if (active) throw fail('当前仓库已有活动盘点单，请先完成或取消', 409)
    if (!input.sections.length) throw fail('至少需要一个盘点分区', 400)
    if (input.documentType && input.sections.length !== 1) throw fail(input.documentType === 'MULTI' ? '多人盘点子单只能包含一个独立盘点清单' : '普通盘点单只能由当前人员单独盘点', 400)
    if (input.documentType && input.sections[0]?.assignedToId !== input.userId) throw fail('盘点单负责人必须是当前创建人', 403)
    if (input.sections.some(section => !section.productIds.length)) throw fail('每个分区至少分配一个商品', 400)
    const names = input.sections.map(section => section.name.trim())
    if (names.some(name => !name) || new Set(names).size !== names.length) throw fail('分区名称不能为空或重复', 400)
    const productIds = input.sections.flatMap(section => section.productIds)
    if (!productIds.length || new Set(productIds).size !== productIds.length) throw fail('盘点商品不能为空或跨分区重复', 400)
    const selection = await resolveWarehouseStocktakeSelection(tx, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      countDate: input.countDate,
      countScope: expectedCountScope,
      planId: input.planId,
      selectionRule: input.selectionRule,
      periodUnit: input.periodUnit,
      manualProductIds: productIds,
    })
    if ((input.planId || selection.selectionRule !== 'MANUAL_SELECTED') && !input.selectionFingerprint) {
      throw fail('方案或自动圈定创建前必须先预览并提交圈定指纹', 400)
    }
    const selectedIds = selection.products.map(product => product.id).sort()
    if (JSON.stringify([...productIds].sort()) !== JSON.stringify(selectedIds)) throw fail('盘点商品已与服务器最新圈定结果不一致，请重新预览', 409)
    if (input.selectionFingerprint && input.selectionFingerprint !== selection.selectionFingerprint) throw fail('盘点方案、商品政策或库存已变化，请重新预览圈定结果', 409)
    const assigneeIds = [...new Set(input.sections.map(section => section.assignedToId))]
    const users = await tx.user.findMany({
      where: { tenantId: input.tenantId, id: { in: assigneeIds }, status: 'ACTIVE', role: { in: [...WAREHOUSE_STOCKTAKE_WRITE_ROLES] } },
      select: { id: true },
    })
    if (users.length !== assigneeIds.length) throw fail('分区负责人必须是本租户启用中的供应链写入人员', 400)
    const { balances, productsById, balancesByProduct } = await loadWarehouseStocktakeProducts(tx, {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      productIds,
    })
    const stocktake = await tx.warehouseStocktake.create({
      data: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        no: `WST-${input.countDate.replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
        countDate: new Date(`${input.countDate}T00:00:00.000Z`),
        requestKey: input.requestKey,
        postingPolicy: 'REVIEW',
        countScope: selection.countScope,
        planId: selection.plan?.id || null,
        planNoSnapshot: selection.plan?.no || null,
        planNameSnapshot: selection.plan?.name || null,
        selectionRuleSnapshot: selection.selectionRule,
        selectionPeriodUnitSnapshot: selection.periodUnit,
        selectionWindowStart: selection.windowStart,
        selectionWindowEndExclusive: selection.windowEndExclusive,
        selectionFingerprint: selection.selectionFingerprint,
        documentType: input.documentType || 'LEGACY',
        note: input.note?.trim() || null,
        createdById: input.userId,
        itemCount: productIds.length,
        totalBookValue: balances.reduce((sum, balance) => sum.plus(balance.inventoryValue), ZERO),
      },
    })
    let sortOrder = 0
    const additionSource = selection.plan ? 'PLAN' : selection.selectionRule === 'MANUAL_SELECTED' ? 'MANUAL' : 'SYSTEM'
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
        const balance = balancesByProduct.get(productId)
        await tx.warehouseStocktakeItem.create({
          data: warehouseStocktakeItemData({
            tenantId: input.tenantId,
            stocktakeId: stocktake.id,
            sectionId: section.id,
            product,
            balance,
            sortOrder: sortOrder++,
            additionSource,
          }),
        })
      }
    }
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId,
      action: input.documentType === 'MULTI' ? '新建多人盘点子单' : '新建总仓盘点单',
      entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no,
      metadata: { documentType: input.documentType || 'LEGACY', countScope: selection.countScope, selectionRule: selection.selectionRule, planId: selection.plan?.id || null, itemCount: productIds.length },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function updateWarehouseStocktakeHeader(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  countDate: string
  note?: string | null
  now?: Date
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.countDate)) throw fail('盘点日期无效', 400)
  const note = input.note?.trim() || null
  const requestFingerprint = lifecycleFingerprint('HEADER_EDIT', input.id, input.rowVersion, {
    actorId: input.userId,
    countDate: input.countDate,
    note,
  })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'HEADER_EDIT', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'HEADER_EDIT', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    if (input.countDate !== businessDateKey(input.now)) throw fail('当前版本只允许使用上海业务日当天作为盘点日期', 409)
    await assertCreatorOrAdministrator(tx, stocktake, input.userId)
    await assertPreApprovalEditable(tx, stocktake)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    if (hasFrozenSelection(stocktake) && stocktake.countDate.toISOString().slice(0, 10) !== input.countDate) {
      throw fail('方案或自动圈定盘点单的盘点日期已冻结，不能修改', 409)
    }
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'HEADER_EDIT',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      fromStatus: stocktake.status,
      toStatus: stocktake.status,
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: {
        before: { countDate: stocktake.countDate.toISOString().slice(0, 10), note: stocktake.note },
        after: { countDate: input.countDate, note },
      },
    })
    const changed = await tx.warehouseStocktake.updateMany({
      where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null, rowVersion: input.rowVersion, status: { in: ['DRAFT', 'COUNTING'] } },
      data: { countDate: new Date(`${input.countDate}T00:00:00.000Z`), note, rowVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw fail('盘点单已被更新，请刷新后重试', 409)
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '修改总仓盘点表头',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { countDate: input.countDate, note },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function addWarehouseStocktakeItems(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  sectionId: string
  productIds: string[]
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  if (!input.productIds.length || input.productIds.length > 500) throw fail('请选1至500个商品', 400)
  if (new Set(input.productIds).size !== input.productIds.length) throw fail('不能重复添加同一商品', 400)
  const requestFingerprint = lifecycleFingerprint('ITEM_ADD', input.id, input.rowVersion, {
    actorId: input.userId,
    sectionId: input.sectionId,
    productIds: input.productIds,
  })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'ITEM_ADD', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'ITEM_ADD', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    await assertCreatorOrAdministrator(tx, stocktake, input.userId)
    await assertPreApprovalEditable(tx, stocktake)
    if (hasFrozenSelection(stocktake)) throw fail('方案或自动圈定盘点单不允许人工增删商品', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    const section = stocktake.sections.find(row => row.id === input.sectionId)
    if (!section) throw fail('盘点分区不存在', 404)
    if (section.status !== 'OPEN') throw fail('已提交分区不能增加商品，请先撤回或驳回', 409)
    const existing = new Set(stocktake.sections.flatMap(row => row.items.map(item => item.productId)))
    if (existing.size + input.productIds.length > MAX_WAREHOUSE_STOCKTAKE_ITEMS) throw fail(`单张盘点单最多包含${MAX_WAREHOUSE_STOCKTAKE_ITEMS}个商品`, 400)
    const duplicate = input.productIds.find(productId => existing.has(productId))
    if (duplicate) throw fail('所选商品已在当前盘点单中', 409)
    const { productsById, balancesByProduct } = await loadWarehouseStocktakeProducts(tx, {
      tenantId: input.tenantId,
      warehouseId: stocktake.warehouseId,
      productIds: input.productIds,
    })
    const blockedPolicies = await tx.warehouseStocktakeProductPolicy.findMany({
      where: {
        tenantId: input.tenantId,
        warehouseId: stocktake.warehouseId,
        productId: { in: input.productIds },
        canCount: false,
      },
      select: { productId: true, reason: true },
    })
    if (blockedPolicies.length) {
      const blocked = blockedPolicies[0]
      throw fail(`「${productsById.get(blocked.productId)?.name || '所选商品'}」已设置为禁止盘点：${blocked.reason || '未填写原因'}`, 409)
    }
    let sortOrder = stocktake.sections.flatMap(row => row.items).reduce((maximum, item) => Math.max(maximum, item.sortOrder), -1) + 1
    await tx.warehouseStocktakeItem.createMany({
      data: input.productIds.map(productId => warehouseStocktakeItemData({
        tenantId: input.tenantId,
        stocktakeId: stocktake.id,
        sectionId: section.id,
        product: productsById.get(productId)!,
        balance: balancesByProduct.get(productId),
        sortOrder: sortOrder++,
        additionSource: 'MANUAL',
      })),
    })
    await tx.warehouseStocktakeSection.update({ where: { id: section.id }, data: { rowVersion: { increment: 1 } } })
    await recalculateWarehouseStocktake(tx, input.tenantId, stocktake.id)
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'ITEM_ADD',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      fromStatus: stocktake.status,
      toStatus: stocktake.status,
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: { sectionId: section.id, productIds: input.productIds },
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '人工添加总仓盘点商品',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { sectionId: section.id, productIds: input.productIds },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function removeWarehouseStocktakeItems(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  itemIds: string[]
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  if (!input.itemIds.length || input.itemIds.length > 500) throw fail('请选1至500个盘点商品', 400)
  if (new Set(input.itemIds).size !== input.itemIds.length) throw fail('不能重复移除同一商品', 400)
  const requestFingerprint = lifecycleFingerprint('ITEM_REMOVE', input.id, input.rowVersion, {
    actorId: input.userId,
    itemIds: input.itemIds,
  })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'ITEM_REMOVE', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'ITEM_REMOVE', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    await assertCreatorOrAdministrator(tx, stocktake, input.userId)
    await assertPreApprovalEditable(tx, stocktake)
    if (hasFrozenSelection(stocktake)) throw fail('方案或自动圈定盘点单不允许人工增删商品', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    const selectedItems = stocktake.sections.flatMap(section => section.items.map(item => ({ ...item, sectionStatus: section.status })))
      .filter(item => input.itemIds.includes(item.id))
    if (selectedItems.length !== input.itemIds.length) throw fail('所选商品不属于当前盘点单', 400)
    if (selectedItems.some(item => item.sectionStatus !== 'OPEN')) throw fail('已提交分区不能移除商品，请先撤回或驳回', 409)
    for (const section of stocktake.sections) {
      const removedFromSection = selectedItems.filter(item => item.sectionId === section.id).length
      if (removedFromSection && section.items.length - removedFromSection < 1) throw fail('每个盘点分区至少保留一个商品', 400)
    }
    await tx.warehouseStocktakeEntry.deleteMany({ where: { tenantId: input.tenantId, stocktakeId: stocktake.id, stocktakeItemId: { in: input.itemIds } } })
    await tx.warehouseStocktakeItem.deleteMany({ where: { tenantId: input.tenantId, stocktakeId: stocktake.id, id: { in: input.itemIds } } })
    const affectedSectionIds = [...new Set(selectedItems.map(item => item.sectionId))]
    await tx.warehouseStocktakeSection.updateMany({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id, id: { in: affectedSectionIds } },
      data: { rowVersion: { increment: 1 } },
    })
    await recalculateWarehouseStocktake(tx, input.tenantId, stocktake.id)
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'ITEM_REMOVE',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      fromStatus: stocktake.status,
      toStatus: stocktake.status,
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: {
        itemIds: input.itemIds,
        products: selectedItems.map(item => ({ itemId: item.id, productId: item.productId, productName: item.productNameSnapshot })),
      },
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '人工移除总仓盘点商品',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { itemIds: input.itemIds, productIds: selectedItems.map(item => item.productId) },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function reorderWarehouseStocktakeItems(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  sectionId: string
  itemIds: string[]
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  if (!input.itemIds.length || input.itemIds.length > MAX_WAREHOUSE_STOCKTAKE_ITEMS) throw fail('排序明细不能为空', 400)
  if (new Set(input.itemIds).size !== input.itemIds.length) throw fail('排序明细不能包含重复商品', 400)
  const requestFingerprint = lifecycleFingerprint('ITEM_REORDER', input.id, input.rowVersion, {
    actorId: input.userId,
    sectionId: input.sectionId,
    itemIds: input.itemIds,
  })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'ITEM_REORDER', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'ITEM_REORDER', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    await assertCreatorOrAdministrator(tx, stocktake, input.userId)
    await assertPreApprovalEditable(tx, stocktake)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    const section = stocktake.sections.find(row => row.id === input.sectionId)
    if (!section) throw fail('盘点分区不存在', 404)
    if (section.status !== 'OPEN') throw fail('已提交分区不能调整顺序，请先撤回或驳回', 409)
    const existingIds = section.items.map(item => item.id)
    if (existingIds.length !== input.itemIds.length || input.itemIds.some(itemId => !existingIds.includes(itemId))) {
      throw fail('排序明细必须完整包含当前分区全部商品', 400)
    }
    const positions = section.items.map(item => item.sortOrder).sort((left, right) => left - right)
    for (const [index, itemId] of input.itemIds.entries()) {
      const changed = await tx.warehouseStocktakeItem.updateMany({
        where: { id: itemId, tenantId: input.tenantId, stocktakeId: stocktake.id, sectionId: section.id },
        data: { sortOrder: positions[index] },
      })
      if (changed.count !== 1) throw fail('排序明细已变化，请刷新后重试', 409)
    }
    await tx.warehouseStocktakeSection.update({ where: { id: section.id }, data: { rowVersion: { increment: 1 } } })
    await tx.warehouseStocktake.update({ where: { id: stocktake.id }, data: { rowVersion: { increment: 1 } } })
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'ITEM_REORDER',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      fromStatus: stocktake.status,
      toStatus: stocktake.status,
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: { sectionId: section.id, itemIds: input.itemIds },
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '调整总仓盘点商品顺序',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { sectionId: section.id, itemIds: input.itemIds },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
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
    if (stocktake.mergeSources.length) throw fail('该多人盘点子单已生成正式盘点单，不能再修改', 409)
    const section = stocktake.sections.find(row => row.id === input.sectionId)
    if (!section) throw fail('盘点分区不存在', 404)
    if (section.assignedToId !== input.userId) throw fail('只能录入分配给自己的盘点分区', 403)
    if (section.status === 'SUBMITTED') throw fail('该分区已提交，请由审核人退回后再修改', 409)
    if (section.rowVersion !== input.rowVersion) throw fail('该分区已被更新，请刷新后重新录入', 409)
    if (new Set(input.items.map(item => item.itemId)).size !== input.items.length) throw fail('不能重复录入同一商品', 400)
    for (const entry of input.items) {
      const item = section.items.find(row => row.id === entry.itemId)
      if (!item) throw fail('录入商品不属于当前分区', 400)
      if (item.unitPending) throw fail(`「${item.productNameSnapshot}」换算待核验，请先补齐并刷新换算`, 400)
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
    if (input.submit && sectionItems.some(item => item.unitPending)) throw fail('分区存在待核验换算，不能提交正式盘点', 400)
    if (input.submit && sectionItems.some(item => item.countedQuantity == null)) throw fail('请完整录入分区内全部商品后再提交', 400)
    if (input.submit) {
      const missingReason = sectionItems.find(item => !dec(item.differenceQuantity || 0).isZero() && !item.reason?.trim())
      if (missingReason) throw fail(`「${missingReason.productNameSnapshot}」存在差异，请填写盘盈/盘亏原因后再提交分区`, 400)
    }
    const changed = await tx.warehouseStocktakeSection.updateMany({
      where: { id: section.id, tenantId: input.tenantId, rowVersion: input.rowVersion, status: 'OPEN' },
      data: { rowVersion: { increment: 1 }, status: input.submit ? 'SUBMITTED' : 'OPEN', submittedAt: input.submit ? new Date() : null },
    })
    if (changed.count !== 1) throw fail('该分区已被更新，请刷新后重试', 409)
    if (input.submit) await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: '提交盘点分区',
      entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no,
      metadata: { sectionId: section.id, sectionName: section.name, itemCount: sectionItems.length },
    } })
    const counted = allEntries.filter(item => item.countedQuantity != null)
    await tx.warehouseStocktake.update({
      where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null },
      data: {
        status: 'COUNTING', rowVersion: { increment: 1 }, countedCount: counted.length,
        differenceCount: counted.filter(item => !dec(item.differenceQuantity || 0).isZero()).length,
        totalCountedValue: counted.reduce((sum, item) => sum.plus(item.countedValue || 0), ZERO),
        totalDifferenceValue: counted.reduce((sum, item) => sum.plus(item.differenceValue || 0), ZERO),
      },
    })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null }, include: detailInclude })
  })
}

export async function refreshWarehouseStocktakeUnits(input: { tenantId: string; id: string; rowVersion: number }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.documentType !== 'MULTI' && stocktake.postingPolicy === 'REVIEW' && stocktake.status === 'CONFIRMED') throw fail('盘点审核后已调整库存；请使用安全反审核，不能直接退回录入', 409)
    if (stocktake.documentType === 'MULTI' && (stocktake.mergeSources.length || stocktake.generatedStocktakeId)) throw fail('该多人盘点子单已生成正式盘点单，不能退回', 409)
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('仅录入中的盘点草稿可以刷新换算', 409)
    const pending = stocktake.sections.flatMap(section => section.items).filter(item => item.unitPending)
    if (!pending.length) return stocktake
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点已更新，请刷新后重试', 409)
    for (const item of pending) {
      const product = await tx.product.findFirst({ where: { tenantId: input.tenantId, id: item.productId, status: 'ENABLED', unitConversionStatus: 'VERIFIED' } })
      if (!product) throw fail(`「${item.productNameSnapshot}」尚未补齐并核验换算`, 400)
      const inventoryUnit = resolveProductFourUnits(product).inventoryUnit
      const balance = await tx.warehouseLedgerBalance.upsert({
        where: { tenantId_warehouseId_productId: { tenantId: input.tenantId, warehouseId: stocktake.warehouseId, productId: item.productId } },
        create: { tenantId: input.tenantId, warehouseId: stocktake.warehouseId, productId: item.productId, inventoryUnit }, update: {},
      })
      if (balance.inventoryUnit !== inventoryUnit) throw fail(`「${item.productNameSnapshot}」库存单位与现有台账不同，不能自动改写`, 409)
      await tx.warehouseStocktakeItem.update({ where: { id: item.id }, data: {
        unitPending: false, inventoryUnit, bookQuantity: balance.physicalQty, bookValue: balance.inventoryValue,
        averageUnitCost: balance.averageUnitCost, bookBalanceVersion: balance.rowVersion,
      } })
    }
    const items = await tx.warehouseStocktakeItem.findMany({ where: { tenantId: input.tenantId, stocktakeId: input.id } })
    await tx.warehouseStocktake.update({ where: { id: input.id, tenantId: input.tenantId, deletedAt: null }, data: { rowVersion: { increment: 1 }, totalBookValue: items.reduce((sum, item) => sum.plus(item.bookValue), ZERO) } })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: input.id, tenantId: input.tenantId, deletedAt: null }, include: detailInclude })
  })
}

export async function submitWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion: number; requireExactVersion?: boolean; batchItemId?: string }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.documentType === 'MULTI') {
      const ownerSection = stocktake.sections.length === 1 ? stocktake.sections[0] : null
      if (!ownerSection || stocktake.createdById !== input.userId || ownerSection.assignedToId !== input.userId) {
        throw fail('只能由多人盘点子单创建人本人提交审核', 403)
      }
    }
    if (input.requireExactVersion && stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已更新，请刷新后重试', 409)
    if (stocktake.status === 'REVIEWING') return stocktake
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('当前状态不能汇总提交', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已更新，请刷新后重试', 409)
    if (stocktake.sections.some(section => section.status !== 'SUBMITTED')) throw fail('请先完成并提交所有盘点分区', 400)
    const items = stocktake.sections.flatMap(section => section.items)
    if (items.some(item => item.unitPending)) throw fail('存在待核验换算，不能提交正式盘点', 400)
    if (!items.length || items.some(item => item.countedQuantity == null)) throw fail('实盘数据不完整', 400)
    const missingReason = items.find(item => !dec(item.differenceQuantity || 0).isZero() && !item.reason?.trim())
    if (missingReason) throw fail(`「${missingReason.productNameSnapshot}」存在差异，请填写盘盈/盘亏原因`, 400)
    const updated = await tx.warehouseStocktake.updateMany({
      where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null, rowVersion: input.rowVersion, status: { in: ['DRAFT', 'COUNTING'] } },
      data: { status: 'REVIEWING', submittedAt: new Date(), submittedById: input.userId, rowVersion: { increment: 1 }, reviewNote: null, lastBatchItemId: input.batchItemId },
    })
    if (updated.count !== 1) throw fail('盘点单已被其他人提交', 409)
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: '提交总仓盘点单审核',
      entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no,
      metadata: { documentType: stocktake.documentType, itemCount: items.length },
    } })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null }, include: detailInclude })
  })
}

export async function withdrawWarehouseStocktake(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  reason?: string | null
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  const reason = input.reason?.trim() || null
  const requestFingerprint = lifecycleFingerprint('WITHDRAW', input.id, input.rowVersion, { actorId: input.userId, reason })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'WITHDRAW', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'WITHDRAW', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    if (stocktake.status !== 'REVIEWING') throw fail('只有待审核盘点单可以由提交人撤回', 409)
    if (stocktake.submittedById !== input.userId) throw fail('只能由本次提交人撤回盘点单', 403)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    if (stocktake.documentType === 'MULTI' && hasGenerationRelation(stocktake)) throw fail('该多人盘点子单已汇总，不能撤回', 409)
    await assertNoPostingEvidence(tx, stocktake)
    await tx.warehouseStocktakeSection.updateMany({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id },
      data: { status: 'OPEN', submittedAt: null, rowVersion: { increment: 1 } },
    })
    const changed = await tx.warehouseStocktake.updateMany({
      where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null, rowVersion: input.rowVersion, status: 'REVIEWING', submittedById: input.userId },
      data: { status: 'COUNTING', submittedAt: null, submittedById: null, reviewNote: reason, rowVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw fail('盘点单已被更新，请刷新后重试', 409)
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'WITHDRAW',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      reason,
      fromStatus: stocktake.status,
      toStatus: 'COUNTING',
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: { submittedAt: stocktake.submittedAt?.toISOString() || null },
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '提交人撤回总仓盘点',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { reason },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function rejectWarehouseStocktake(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  reason: string
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  const reason = input.reason.trim()
  if (reason.length < 2 || reason.length > 500) throw fail('请填写驳回原因（2至500个字符）', 400)
  const requestFingerprint = lifecycleFingerprint('REJECT', input.id, input.rowVersion, { actorId: input.userId, reason })
  return serializable(async tx => {
    const replay = await lifecycleReplay(tx, input, 'REJECT', requestFingerprint)
    if (replay) return replay
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await lifecycleReplay(tx, input, 'REJECT', requestFingerprint)
    if (concurrentReplay) return concurrentReplay
    await assertAuditActor(tx, input.tenantId, input.userId)
    if (stocktake.status !== 'REVIEWING') {
      if (stocktake.status === 'CONFIRMED') throw fail('已审核盘点单只能使用安全反审核，不能驳回', 409)
      throw fail('只有待审核盘点单可以驳回', 409)
    }
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    if (stocktake.documentType === 'MULTI' && hasGenerationRelation(stocktake)) throw fail('该多人盘点子单已汇总，不能驳回', 409)
    await assertNoPostingEvidence(tx, stocktake)
    await tx.warehouseStocktakeSection.updateMany({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id },
      data: { status: 'OPEN', submittedAt: null, rowVersion: { increment: 1 } },
    })
    const changed = await tx.warehouseStocktake.updateMany({
      where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null, rowVersion: input.rowVersion, status: 'REVIEWING' },
      data: { status: 'COUNTING', submittedAt: null, submittedById: null, reviewNote: reason, rowVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw fail('盘点单已被更新，请刷新后重试', 409)
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'REJECT',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      reason,
      fromStatus: stocktake.status,
      toStatus: 'COUNTING',
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: { submittedById: stocktake.submittedById },
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '审核人驳回总仓盘点',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { reason },
    } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export async function deleteWarehouseStocktake(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  reason: string
  batchItemId?: string
}) {
  assertLifecycleRequest(input.requestKey, input.rowVersion)
  const reason = input.reason.trim()
  if (reason.length < 2 || reason.length > 500) throw fail('请填写删除原因（2至500个字符）', 400)
  const requestFingerprint = lifecycleFingerprint('DELETE', input.id, input.rowVersion, { actorId: input.userId, reason })

  return serializable(async tx => {
    const replayEvent = await tx.warehouseStocktakeLifecycleEvent.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
    })
    if (replayEvent) {
      if (replayEvent.action !== 'DELETE' || replayEvent.stocktakeId !== input.id || replayEvent.requestFingerprint !== requestFingerprint) {
        throw fail('同一请求编号不能用于不同的盘点删除操作', 409)
      }
      const tombstone = await tx.warehouseStocktake.findFirst({
        where: { tenantId: input.tenantId, id: input.id, deletedAt: { not: null } },
        select: { id: true, no: true, deletedAt: true, rowVersion: true },
      })
      if (!tombstone?.deletedAt) throw fail('删除审计与盘点墓碑不一致，请联系管理员核对', 409)
      return { replayed: true, deleted: tombstone }
    }

    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "warehouse_stocktakes"
      WHERE "tenantId" = ${input.tenantId} AND "id" = ${input.id}
      FOR UPDATE
    `)
    if (!lockedRows.length) throw fail('总仓盘点单不存在', 404)
    const stocktake = await tx.warehouseStocktake.findFirstOrThrow({
      where: { tenantId: input.tenantId, id: input.id },
      include: detailInclude,
    })
    const concurrentReplay = await tx.warehouseStocktakeLifecycleEvent.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
    })
    if (concurrentReplay) {
      if (concurrentReplay.action !== 'DELETE' || concurrentReplay.stocktakeId !== input.id || concurrentReplay.requestFingerprint !== requestFingerprint) {
        throw fail('同一请求编号不能用于不同的盘点删除操作', 409)
      }
      const tombstone = await tx.warehouseStocktake.findFirstOrThrow({
        where: { tenantId: input.tenantId, id: input.id, deletedAt: { not: null } },
        select: { id: true, no: true, deletedAt: true, rowVersion: true },
      })
      return { replayed: true, deleted: tombstone }
    }

    if (stocktake.deletedAt) throw fail('总仓盘点单不存在', 404)

    await assertCreatorOrAdministrator(tx, stocktake, input.userId)
    if (!['DRAFT', 'COUNTING', 'CANCELLED'].includes(stocktake.status)) throw fail('只有草稿、盘点中或已取消单据可以删除', 409)
    if (stocktake.reviewStatus !== 'UNREVIEWED') throw fail('已复审盘点单不能删除', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后重试', 409)
    if (hasGenerationRelation(stocktake)) throw fail('已汇总、已生成或由多人盘点生成的单据不能删除', 409)
    const reverseReference = await tx.warehouseStocktake.findFirst({
      where: {
        tenantId: input.tenantId,
        OR: [{ sourceMultiId: stocktake.id }, { generatedStocktakeId: stocktake.id }],
      },
      select: { id: true },
    })
    if (reverseReference) throw fail('该盘点单仍被其他盘点单引用，不能删除', 409)
    await assertNoPostingEvidence(tx, stocktake)
    const ledgerEvidence = await tx.warehouseLedgerMovement.findFirst({
      where: {
        tenantId: input.tenantId,
        OR: [
          { sourceType: 'WarehouseStocktake', sourceId: stocktake.id },
          { sourceType: 'WarehouseStocktakeReversal', sourceId: stocktake.id },
        ],
      },
      select: { id: true },
    })
    if (ledgerEvidence) throw fail('该盘点单已有库存流水证据，不能删除', 409)

    const deletedAt = new Date()
    await createPreApprovalLifecycleEvent(tx, {
      tenantId: input.tenantId,
      stocktakeId: stocktake.id,
      action: 'DELETE',
      requestKey: input.requestKey,
      requestFingerprint,
      actorId: input.userId,
      reason,
      fromStatus: stocktake.status,
      toStatus: stocktake.status,
      fromReviewStatus: stocktake.reviewStatus,
      toReviewStatus: stocktake.reviewStatus,
      metadata: { itemCount: stocktake.itemCount, documentType: stocktake.documentType },
    })
    const changed = await tx.warehouseStocktake.updateMany({
      where: {
        tenantId: input.tenantId,
        id: stocktake.id,
        deletedAt: null,
        rowVersion: input.rowVersion,
        status: { in: ['DRAFT', 'COUNTING', 'CANCELLED'] },
      },
      data: {
        deletedAt,
        deletedById: input.userId,
        deleteReason: reason,
        lastBatchItemId: input.batchItemId,
        rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) throw fail('盘点单已被更新，请刷新后重试', 409)
    await tx.opLog.create({ data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '软删除总仓盘点单',
      entityType: 'WarehouseStocktake',
      targetId: stocktake.id,
      target: stocktake.no,
      metadata: { reason, previousStatus: stocktake.status },
    } })
    return { replayed: false, deleted: { id: stocktake.id, no: stocktake.no, deletedAt, rowVersion: stocktake.rowVersion + 1 } }
  })
}

export async function cancelWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion: number; reason: string }) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (stocktake.documentType === 'FORMAL' && stocktake.generatedFrom.length) throw fail('该正式盘点单已绑定多人盘点来源，不能取消', 409)
    if (stocktake.documentType === 'MULTI' && (stocktake.mergeSources.length || stocktake.generatedStocktakeId)) throw fail('该多人盘点子单已生成正式盘点单，不能取消', 409)
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) throw fail('只有草稿或盘点中单据可以取消', 409)
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后再取消', 409)
    const updated = await tx.warehouseStocktake.updateMany({
      where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null, rowVersion: input.rowVersion, status: { in: ['DRAFT', 'COUNTING'] } },
      data: { status: 'CANCELLED', reviewNote: input.reason, rowVersion: { increment: 1 } },
    })
    if (updated.count !== 1) throw fail('盘点单已被更新，请刷新后再取消', 409)
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: '取消总仓盘点', entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no, metadata: { reason: input.reason } } })
    return tx.warehouseStocktake.findFirstOrThrow({ where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null } })
  })
}

export async function approveWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion?: number; batchItemId?: string }) {
  return finishWarehouseStocktake(input, false)
}
export async function reviewWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion?: number; batchItemId?: string }) {
  return finishWarehouseStocktake(input, true)
}

export async function reverseWarehouseStocktakeApproval(input: {
  tenantId: string
  userId: string
  id: string
  rowVersion: number
  requestKey: string
  batchItemId?: string
  reason: string
}) {
  const reason = String(input.reason || '').trim()
  const requestKey = String(input.requestKey || '').trim()
  if (reason.length < 2 || reason.length > 500) throw fail('请填写反审核原因（2至500个字符）', 400)
  if (!requestKey || requestKey.length > 160) throw fail('反审核请求编号无效', 400)
  if (!Number.isSafeInteger(input.rowVersion) || input.rowVersion < 0) throw fail('盘点单版本无效', 400)
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    action: 'REVERSE_APPROVAL', stocktakeId: input.id, rowVersion: input.rowVersion, reason,
  })).digest('hex')

  return serializable(async tx => {
    const replay = await tx.warehouseStocktakeLifecycleEvent.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey } },
    })
    if (replay) {
      if (replay.action !== 'REVERSE_APPROVAL' || replay.stocktakeId !== input.id || replay.requestFingerprint !== requestFingerprint) {
        throw fail('同一请求编号不能用于不同的反审核内容', 409)
      }
      return { replayed: true, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: input.id, deletedAt: null }, include: detailInclude }) }
    }

    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    const concurrentReplay = await tx.warehouseStocktakeLifecycleEvent.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey } },
    })
    if (concurrentReplay) {
      if (concurrentReplay.action !== 'REVERSE_APPROVAL' || concurrentReplay.stocktakeId !== input.id || concurrentReplay.requestFingerprint !== requestFingerprint) {
        throw fail('同一请求编号不能用于不同的反审核内容', 409)
      }
      return { replayed: true, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: input.id, deletedAt: null }, include: detailInclude }) }
    }
    if (stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已被更新，请刷新后再反审核', 409)
    if (stocktake.documentType === 'MULTI') {
      if (stocktake.mergeSources.length || stocktake.generatedStocktakeId) throw fail('已汇总生成正式盘点单的多人盘点来源不能反审核', 409)
      throw fail('多人盘点子单不直接过账，不能使用库存反审核', 409)
    }
    if (!['LEGACY', 'FORMAL'].includes(stocktake.documentType)) throw fail('当前盘点单类型不能反审核', 409)
    if (stocktake.postingPolicy !== 'REVIEW') throw fail('历史盘点缺少当前过账语义，不能自动反审核', 409)
    if (stocktake.status !== 'CONFIRMED') throw fail('只有已审核盘点单可以反审核', 409)
    if (stocktake.reviewStatus === 'REVIEWED') throw fail('已复审盘点单不能反审核', 409)
    if (stocktake.postingCycle <= 0) throw fail('历史盘点缺少过账轮次，不能自动反审核', 409)

    const items = stocktake.sections.flatMap(section => section.items).sort((a, b) => a.productId.localeCompare(b.productId))
    if (!items.length || items.some(item => item.approvedPostingSequence == null || item.approvedBalanceVersion == null)) {
      throw fail('该已审核盘点缺少审核后库存凭据，不能自动反审核', 409)
    }
    const approvalEvidence = await tx.warehouseStocktakeLifecycleEvent.findFirst({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id, cycle: stocktake.postingCycle, action: 'APPROVE' },
      select: { sequence: true },
    })
    if (!approvalEvidence) throw fail('该已审核盘点缺少本轮审核事件，不能自动反审核', 409)
    const adjustments = stocktake.adjustments.filter(row => row.cycle === stocktake.postingCycle)
    if (adjustments.some(row => row.status !== 'POSTED')) throw fail('本轮盘盈盘亏调整单已冲销或状态异常', 409)
    const adjustmentLines = adjustments.flatMap(row => row.lines)
    const movementByItem = new Map(adjustmentLines.map(line => [line.stocktakeItemId, line.movementId]))
    const differenceItems = items.filter(item => !dec(item.differenceQuantity || 0).isZero())
    if (adjustmentLines.length !== differenceItems.length
      || differenceItems.some(item => !movementByItem.get(item.id))
      || adjustmentLines.some(line => !differenceItems.some(item => item.id === line.stocktakeItemId))) {
      throw fail('本轮盘盈盘亏调整流水不完整，不能反审核', 409)
    }

    const reversed = await reverseWarehouseStocktakeCycleInTransaction(tx, {
      tenantId: input.tenantId,
      warehouseId: stocktake.warehouseId,
      stocktakeId: stocktake.id,
      stocktakeNo: stocktake.no,
      postingCycle: stocktake.postingCycle,
      approvalSequence: approvalEvidence.sequence,
      userId: input.userId,
      reason,
      items: items.map(item => ({
        stocktakeItemId: item.id,
        productId: item.productId,
        productName: item.productNameSnapshot,
        inventoryUnit: item.inventoryUnit,
        approvedPostingSequence: item.approvedPostingSequence!,
        approvedBalanceVersion: item.approvedBalanceVersion!,
        originalMovementId: movementByItem.get(item.id),
      })),
    })

    const reversedAt = new Date()
    if (adjustments.length) {
      await tx.warehouseStocktakeAdjustment.updateMany({
        where: { tenantId: input.tenantId, stocktakeId: stocktake.id, cycle: stocktake.postingCycle, status: 'POSTED' },
        data: { status: 'REVERSED', reversedAt, reversedById: input.userId, reversalReason: reason },
      })
    }
    let totalBookValue = ZERO
    let totalCountedValue = ZERO
    let totalDifferenceValue = ZERO
    let differenceCount = 0
    for (const item of items) {
      const balance = reversed.balances.get(item.productId)!
      const countedValue = item.countedQuantity != null && item.countedUnitCost != null
        ? item.countedQuantity.mul(item.countedUnitCost).toDecimalPlaces(4)
        : null
      const differenceQuantity = item.countedQuantity == null ? null : item.countedQuantity.minus(balance.physicalQty).toDecimalPlaces(6)
      const differenceValue = countedValue == null ? null : countedValue.minus(balance.inventoryValue).toDecimalPlaces(4)
      await tx.warehouseStocktakeItem.update({
        where: { id: item.id },
        data: {
          bookQuantity: balance.physicalQty,
          bookValue: balance.inventoryValue,
          averageUnitCost: balance.averageUnitCost,
          bookBalanceVersion: balance.rowVersion,
          countedValue,
          differenceQuantity,
          differenceValue,
          approvedPostingSequence: null,
          approvedBalanceVersion: null,
        },
      })
      totalBookValue = totalBookValue.plus(balance.inventoryValue)
      if (countedValue != null) totalCountedValue = totalCountedValue.plus(countedValue)
      if (differenceValue != null) totalDifferenceValue = totalDifferenceValue.plus(differenceValue)
      if (differenceQuantity != null && !differenceQuantity.isZero()) differenceCount += 1
    }
    await tx.warehouseStocktakeSection.updateMany({
      where: { tenantId: input.tenantId, stocktakeId: stocktake.id },
      data: { status: 'OPEN', submittedAt: null, rowVersion: { increment: 1 } },
    })
    await tx.warehouseStocktakeLifecycleEvent.create({ data: {
      tenantId: input.tenantId, stocktakeId: stocktake.id, cycle: stocktake.postingCycle, action: 'REVERSE_APPROVAL',
      requestKey, requestFingerprint, actorId: input.userId, reason,
      fromStatus: stocktake.status, toStatus: 'COUNTING', fromReviewStatus: stocktake.reviewStatus, toReviewStatus: 'UNREVIEWED',
      metadata: { originalMovementIds: adjustmentLines.flatMap(line => line.movementId ? [line.movementId] : []), reversalMovementIds: reversed.movements.map(row => row.id) },
    } })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: '反审核总仓盘点并追加冲销流水',
      entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no,
      metadata: { reason, postingCycle: stocktake.postingCycle, reversalMovementIds: reversed.movements.map(row => row.id) },
    } })
    await tx.warehouseStocktake.update({
      where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null },
      data: {
        status: 'COUNTING', reviewStatus: 'UNREVIEWED', submittedAt: null, submittedById: null,
        auditedAt: null, auditedById: null, reviewedAt: null, reviewedById: null, reviewNote: reason,
        lastBatchItemId: input.batchItemId,
        totalBookValue: totalBookValue.toDecimalPlaces(4), totalCountedValue: totalCountedValue.toDecimalPlaces(4),
        totalDifferenceValue: totalDifferenceValue.toDecimalPlaces(4), differenceCount, rowVersion: { increment: 1 },
      },
    })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: stocktake.id, deletedAt: null }, include: detailInclude }) }
  })
}

export type WarehouseStocktakeBatchActionInput = 'SUBMIT' | 'APPROVE' | 'FINAL_REVIEW' | 'REVERSE_APPROVAL' | 'DELETE'

type WarehouseStocktakeBatchInput = {
  tenantId: string
  userId: string
  requestKey: string
  action: WarehouseStocktakeBatchActionInput
  items: Array<{ id: string; rowVersion: number }>
  ignoreInvalid: boolean
  reason?: string | null
}

function batchError(error: any) {
  const statusCode = Number(error?.statusCode || 500)
  const message = String(error?.message || '盘点批量操作失败').slice(0, 500)
  if (statusCode === 403) return { errorCode: 'FORBIDDEN', message }
  if (statusCode === 404) return { errorCode: 'NOT_FOUND', message: '盘点单不存在或无权访问' }
  if (statusCode === 400) return { errorCode: 'VALIDATION_FAILED', message }
  if (statusCode === 409 && /(版本|更新|其他人|并发)/.test(message)) return { errorCode: 'VERSION_CONFLICT', message }
  if (statusCode === 409) return { errorCode: 'INVALID_STATE', message }
  return { errorCode: 'INTERNAL_ERROR', message: '盘点批量操作失败，请使用原请求编号重试' }
}

function batchInvalidReason(action: WarehouseStocktakeBatchActionInput, stocktake: {
  status: string
  reviewStatus: string
  documentType: string
  postingPolicy: string
}) {
  if (action === 'SUBMIT') {
    if (stocktake.status === 'REVIEWING') return { code: 'ALREADY_APPLIED', message: '已提交审核' }
    if (!['DRAFT', 'COUNTING'].includes(stocktake.status)) return { code: 'INVALID_STATE', message: '当前状态不能提交' }
  }
  if (action === 'APPROVE') {
    if (stocktake.status === 'CONFIRMED') return { code: 'ALREADY_APPLIED', message: '已审核' }
    if (stocktake.status !== 'REVIEWING') return { code: 'INVALID_STATE', message: '仅待审核单据可审核' }
  }
  if (action === 'FINAL_REVIEW') {
    if (stocktake.reviewStatus === 'REVIEWED') return { code: 'ALREADY_APPLIED', message: '已复审' }
    if (stocktake.documentType === 'MULTI' || stocktake.status !== 'CONFIRMED') return { code: 'INVALID_STATE', message: '仅已审核正式盘点单可复审' }
  }
  if (action === 'REVERSE_APPROVAL') {
    if (stocktake.documentType === 'MULTI') return { code: 'INVALID_STATE', message: '多人盘点子单不直接反审核' }
    if (stocktake.status !== 'CONFIRMED' || stocktake.reviewStatus === 'REVIEWED' || stocktake.postingPolicy !== 'REVIEW') {
      return { code: 'INVALID_STATE', message: stocktake.reviewStatus === 'REVIEWED' ? '已复审单据不能反审核' : '当前状态不能反审核' }
    }
  }
  if (action === 'DELETE' && !['DRAFT', 'COUNTING', 'CANCELLED'].includes(stocktake.status)) {
    return { code: 'INVALID_STATE', message: '仅草稿、盘点中或已取消单据可删除' }
  }
  return null
}

const batchRecoveryStocktakeSelect = {
  id: true,
  rowVersion: true,
  status: true,
  reviewStatus: true,
  submittedById: true,
  auditedById: true,
  reviewedById: true,
  lastBatchItemId: true,
  deletedAt: true,
  deletedById: true,
} satisfies Prisma.WarehouseStocktakeSelect
type BatchRecoveryStocktake = Prisma.WarehouseStocktakeGetPayload<{ select: typeof batchRecoveryStocktakeSelect }>

async function hasBatchTransitionEvidence(input: {
  tenantId: string
  userId: string
  action: WarehouseStocktakeBatchActionInput
  operationId: string
  itemId: string
  stocktakeId: string
  inputRowVersion: number
}, stocktake: BatchRecoveryStocktake) {
  const transitionedOnce = stocktake.rowVersion === input.inputRowVersion + 1 && stocktake.lastBatchItemId === input.itemId
  if (transitionedOnce && (
    (input.action === 'SUBMIT' && stocktake.status === 'REVIEWING' && stocktake.submittedById === input.userId)
    || (input.action === 'APPROVE' && stocktake.status === 'CONFIRMED' && stocktake.auditedById === input.userId)
    || (input.action === 'FINAL_REVIEW' && stocktake.reviewStatus === 'REVIEWED' && stocktake.reviewedById === input.userId)
    || (input.action === 'DELETE' && stocktake.deletedAt != null && stocktake.deletedById === input.userId)
  )) return true
  if (input.action !== 'REVERSE_APPROVAL') return false
  const event = await prisma.warehouseStocktakeLifecycleEvent.findUnique({
    where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: `wst-batch-item:${input.operationId}:${input.itemId}` } },
    select: { action: true, stocktakeId: true },
  })
  return event?.action === 'REVERSE_APPROVAL' && event.stocktakeId === input.stocktakeId
}

async function findBatchTransitionRecovery(input: {
  tenantId: string
  userId: string
  action: WarehouseStocktakeBatchActionInput
  operationId: string
  itemId: string
  stocktakeId: string
  inputRowVersion: number
}) {
  const stocktake = await prisma.warehouseStocktake.findFirst({
    where: {
      tenantId: input.tenantId,
      id: input.stocktakeId,
      ...(input.action === 'DELETE' ? {} : { deletedAt: null }),
    },
    select: batchRecoveryStocktakeSelect,
  })
  if (!stocktake || !(await hasBatchTransitionEvidence(input, stocktake))) return null
  return stocktake
}

async function batchOperationResult(tenantId: string, operationId: string, replayed: boolean) {
  const operation = await prisma.warehouseStocktakeBatchOperation.findFirstOrThrow({
    where: { tenantId, id: operationId },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  const results = operation.items.map(item => ({
    id: item.stocktakeId,
    no: item.stocktakeNo || item.stocktakeId,
    outcome: item.status,
    code: item.errorCode,
    message: item.message,
    rowVersion: item.outputRowVersion,
  }))
  return {
    operationId: operation.id,
    status: operation.status,
    replayed,
    summary: {
      total: results.length,
      succeeded: results.filter(item => item.outcome === 'SUCCEEDED').length,
      failed: results.filter(item => item.outcome === 'FAILED').length,
      skipped: results.filter(item => item.outcome === 'SKIPPED').length,
      pending: results.filter(item => ['PENDING', 'RUNNING'].includes(item.outcome)).length,
    },
    results,
  }
}

export async function executeWarehouseStocktakeBatch(input: WarehouseStocktakeBatchInput) {
  const requestKey = input.requestKey.trim()
  const reason = input.reason?.trim() || null
  if (requestKey.length < 8 || requestKey.length > 160) throw fail('批量操作请求编号无效', 400)
  if (!input.items.length || input.items.length > 100) throw fail('每次请选1至100张盘点单', 400)
  if (new Set(input.items.map(item => item.id)).size !== input.items.length) throw fail('批量操作不能重复选择同一张盘点单', 400)
  if (input.items.some(item => !item.id || !Number.isSafeInteger(item.rowVersion) || item.rowVersion < 0)) throw fail('批量操作单据或版本无效', 400)
  if (['REVERSE_APPROVAL', 'DELETE'].includes(input.action) && (!reason || reason.length < 2 || reason.length > 500)) {
    throw fail(input.action === 'DELETE' ? '请填写删除原因（2至500个字符）' : '请填写反审核原因（2至500个字符）', 400)
  }
  const normalizedItems = [...input.items].sort((a, b) => a.id.localeCompare(b.id))
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    action: input.action,
    actorId: input.userId,
    items: normalizedItems,
    ignoreInvalid: input.ignoreInvalid,
    reason,
  })).digest('hex')

  const acquired = await serializable(async tx => {
    const replay = await tx.warehouseStocktakeBatchOperation.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey } },
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint || replay.action !== input.action || replay.actorId !== input.userId) {
        throw fail('同一请求编号不能用于不同的批量盘点操作', 409)
      }
      return { operation: replay, replayed: true }
    }
    const created = await tx.warehouseStocktakeBatchOperation.create({
      data: {
        tenantId: input.tenantId,
        requestKey,
        requestFingerprint,
        action: input.action,
        actorId: input.userId,
        reason,
        items: { create: normalizedItems.map(item => ({
          stocktakeId: item.id,
          inputRowVersion: item.rowVersion,
        })) },
      },
    })
    return { operation: created, replayed: false }
  })
  const operation = acquired.operation

  if (operation.status === 'COMPLETED') return batchOperationResult(input.tenantId, operation.id, true)

  const pending = await prisma.warehouseStocktakeBatchOperationItem.findMany({
    where: { tenantId: input.tenantId, operationId: operation.id, status: { in: ['PENDING', 'RUNNING'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const item of pending) {
    const leaseToken = randomUUID()
    const now = new Date()
    const claimed = await prisma.warehouseStocktakeBatchOperationItem.updateMany({
      where: {
        tenantId: input.tenantId,
        id: item.id,
        operationId: operation.id,
        OR: [{ status: 'PENDING' }, { status: 'RUNNING', leaseExpiresAt: { lt: now } }],
      },
      data: { status: 'RUNNING', leaseToken, leaseExpiresAt: new Date(now.getTime() + 60_000), attemptCount: { increment: 1 } },
    })
    if (claimed.count !== 1) continue
    try {
      const stocktake = await prisma.warehouseStocktake.findFirst({
        where: {
          tenantId: input.tenantId,
          id: item.stocktakeId,
          ...(input.action === 'DELETE' ? {} : { deletedAt: null }),
        },
        select: {
          id: true, no: true, rowVersion: true, status: true, reviewStatus: true, documentType: true, postingPolicy: true,
          submittedById: true, auditedById: true, reviewedById: true, lastBatchItemId: true, deletedAt: true, deletedById: true,
        },
      })
      if (!stocktake) throw fail('盘点单不存在或无权访问', 404)
      await prisma.warehouseStocktakeBatchOperationItem.updateMany({ where: { tenantId: input.tenantId, id: item.id, leaseToken }, data: { stocktakeNo: stocktake.no } })
      if (stocktake.deletedAt) {
        const recoveryInput = {
          tenantId: input.tenantId, userId: input.userId, action: input.action, operationId: operation.id,
          itemId: item.id, stocktakeId: stocktake.id, inputRowVersion: item.inputRowVersion,
        }
        if (!(await hasBatchTransitionEvidence(recoveryInput, stocktake))) {
          // A different batch must not be able to distinguish a tombstone from
          // an unknown or cross-tenant id through a VERSION_CONFLICT response.
          throw fail('盘点单不存在或无权访问', 404)
        }
        await prisma.warehouseStocktakeBatchOperationItem.updateMany({
          where: { tenantId: input.tenantId, id: item.id, leaseToken },
          data: { status: 'SUCCEEDED', errorCode: null, message: '已根据单据转换证据恢复批量结果', outputRowVersion: stocktake.rowVersion, leaseToken: null, leaseExpiresAt: null },
        })
        continue
      }
      if (stocktake.rowVersion !== item.inputRowVersion) {
        const recoveryInput = {
          tenantId: input.tenantId, userId: input.userId, action: input.action, operationId: operation.id,
          itemId: item.id, stocktakeId: stocktake.id, inputRowVersion: item.inputRowVersion,
        }
        if (!(await hasBatchTransitionEvidence(recoveryInput, stocktake))) {
          throw fail('盘点单已更新，请刷新后重试', 409)
        }
        await prisma.warehouseStocktakeBatchOperationItem.updateMany({
          where: { tenantId: input.tenantId, id: item.id, leaseToken },
          data: { status: 'SUCCEEDED', errorCode: null, message: '已根据单据转换证据恢复批量结果', outputRowVersion: stocktake.rowVersion, leaseToken: null, leaseExpiresAt: null },
        })
        continue
      }
      const invalid = batchInvalidReason(input.action, stocktake)
      if (invalid) {
        await prisma.warehouseStocktakeBatchOperationItem.updateMany({
          where: { tenantId: input.tenantId, id: item.id, leaseToken },
          data: {
            status: input.ignoreInvalid ? 'SKIPPED' : 'FAILED',
            errorCode: invalid.code,
            message: invalid.message,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })
        continue
      }
      let result: any
      if (input.action === 'SUBMIT') result = await submitWarehouseStocktake({
        tenantId: input.tenantId, userId: input.userId, id: item.stocktakeId, rowVersion: item.inputRowVersion, requireExactVersion: true, batchItemId: item.id,
      })
      else if (input.action === 'APPROVE') result = await approveWarehouseStocktake({
        tenantId: input.tenantId, userId: input.userId, id: item.stocktakeId, rowVersion: item.inputRowVersion, batchItemId: item.id,
      })
      else if (input.action === 'FINAL_REVIEW') result = await reviewWarehouseStocktake({
        tenantId: input.tenantId, userId: input.userId, id: item.stocktakeId, rowVersion: item.inputRowVersion, batchItemId: item.id,
      })
      else if (input.action === 'REVERSE_APPROVAL') result = await reverseWarehouseStocktakeApproval({
        tenantId: input.tenantId,
        userId: input.userId,
        id: item.stocktakeId,
        rowVersion: item.inputRowVersion,
        reason: reason!,
        requestKey: `wst-batch-item:${operation.id}:${item.id}`,
        batchItemId: item.id,
      })
      else result = await deleteWarehouseStocktake({
        tenantId: input.tenantId,
        userId: input.userId,
        id: item.stocktakeId,
        rowVersion: item.inputRowVersion,
        reason: reason!,
        requestKey: `wst-batch-item:${operation.id}:${item.id}`,
        batchItemId: item.id,
      })
      const changed = result?.stocktake || result?.deleted || result
      await prisma.warehouseStocktakeBatchOperationItem.updateMany({
        where: { tenantId: input.tenantId, id: item.id, leaseToken },
        data: {
          status: 'SUCCEEDED',
          errorCode: null,
          message: null,
          outputRowVersion: changed.rowVersion,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })
    } catch (error: any) {
      const detail = batchError(error)
      if (detail.errorCode === 'VERSION_CONFLICT') {
        // A previous worker may have committed the domain transition after
        // this lease owner read the old version but before its locked command
        // ran. Re-read after the conflict and use the same durable transition
        // evidence before turning a successful action into a failed item.
        const recovered = await findBatchTransitionRecovery({
          tenantId: input.tenantId, userId: input.userId, action: input.action, operationId: operation.id,
          itemId: item.id, stocktakeId: item.stocktakeId, inputRowVersion: item.inputRowVersion,
        })
        if (recovered) {
          await prisma.warehouseStocktakeBatchOperationItem.updateMany({
            where: { tenantId: input.tenantId, id: item.id, leaseToken },
            data: {
              status: 'SUCCEEDED', errorCode: null, message: '已根据单据转换证据恢复批量结果',
              outputRowVersion: recovered.rowVersion, leaseToken: null, leaseExpiresAt: null,
            },
          })
          continue
        }
      }
      await prisma.warehouseStocktakeBatchOperationItem.updateMany({
        where: { tenantId: input.tenantId, id: item.id, leaseToken },
        data: { status: 'FAILED', ...detail, leaseToken: null, leaseExpiresAt: null },
      })
    }
  }

  const unfinished = await prisma.warehouseStocktakeBatchOperationItem.count({
    where: { tenantId: input.tenantId, operationId: operation.id, status: { in: ['PENDING', 'RUNNING'] } },
  })
  if (!unfinished) await prisma.warehouseStocktakeBatchOperation.updateMany({
    where: { tenantId: input.tenantId, id: operation.id, status: 'RUNNING' },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })
  return batchOperationResult(input.tenantId, operation.id, acquired.replayed)
}

async function finishWarehouseStocktake(input: { tenantId: string; userId: string; id: string; rowVersion?: number; batchItemId?: string }, finalReview: boolean) {
  return serializable(async tx => {
    const stocktake = await lockStocktake(tx, input.tenantId, input.id)
    if (input.rowVersion !== undefined && stocktake.rowVersion !== input.rowVersion) throw fail('盘点单已更新，请刷新后重试', 409)
    if (finalReview) {
      if (stocktake.documentType === 'MULTI') throw fail('多人盘点单不能直接复审过账，请先生成正式盘点单', 409)
      if (stocktake.status !== 'CONFIRMED') throw fail('请先审核盘点单，再复审', 409)
      if (stocktake.reviewStatus === 'REVIEWED') return { replayed: true, stocktake }
      const updated = await tx.warehouseStocktake.update({where:{id:stocktake.id,tenantId:input.tenantId,deletedAt:null},data:{reviewStatus:'REVIEWED',reviewedAt:new Date(),reviewedById:input.userId,rowVersion:{increment:1},lastBatchItemId:input.batchItemId}})
      await tx.opLog.create({data:{tenantId:input.tenantId,userId:input.userId,action:'复审锁定总仓盘点（不重复过账）',entityType:'WarehouseStocktake',targetId:stocktake.id,target:stocktake.no}})
      return {replayed:false,stocktake:updated}
    } else {
      if (stocktake.status === 'CONFIRMED') return { replayed: true, stocktake }
      if (stocktake.status !== 'REVIEWING') throw fail('只有待审核盘点单可以审核', 409)
    }
    const items = stocktake.sections.flatMap(section => section.items).sort((a, b) => a.productId.localeCompare(b.productId))
    if (items.some(item => item.unitPending)) throw fail('存在待核验换算，不能审核盘点', 400)
    const productIds = items.map(item => item.productId)
    const balances = productIds.length ? await tx.$queryRaw<Array<{
      productId: string; physicalQty: Prisma.Decimal; reservedQty: Prisma.Decimal; inventoryValue: Prisma.Decimal; postingSequence: number; rowVersion: number
    }>>(Prisma.sql`
      SELECT "productId", "physicalQty", "reservedQty", "inventoryValue", "postingSequence", "rowVersion"
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
    if (!finalReview && stocktake.documentType === 'MULTI') {
      const updated=await tx.warehouseStocktake.update({where:{id:stocktake.id,tenantId:input.tenantId,deletedAt:null},data:{status:'CONFIRMED',postingPolicy:'REVIEW',auditedAt:new Date(),auditedById:input.userId,reviewNote:null,rowVersion:{increment:1},lastBatchItemId:input.batchItemId}})
      await tx.opLog.create({data:{tenantId:input.tenantId,userId:input.userId,action:'审核多人盘点子单（不改变库存）',entityType:'WarehouseStocktake',targetId:stocktake.id,target:stocktake.no}})
      return {replayed:false,stocktake:updated}
    }
    const effectiveAt = new Date()
    const postingCycle = stocktake.postingCycle + 1
    const grouped = {
      PROFIT: items.filter(item => dec(item.differenceQuantity || 0).gt(0)),
      LOSS: items.filter(item => dec(item.differenceQuantity || 0).lt(0)),
    }
    for (const type of ['PROFIT', 'LOSS'] as const) {
      const selected = grouped[type]
      if (!selected.length) continue
      const adjustment = await tx.warehouseStocktakeAdjustment.create({
        data: {
          tenantId: input.tenantId, stocktakeId: stocktake.id, type,
          cycle: postingCycle,
          no: `${stocktake.no}-${type === 'PROFIT' ? 'PY' : 'PK'}${postingCycle === 1 ? '' : `-R${postingCycle}`}`,
          itemCount: selected.length,
          totalAmount: selected.reduce((sum, item) => sum.plus(dec(item.differenceValue || 0).abs()), ZERO),
        },
      })
      for (const item of selected) {
        const result = await postWarehouseStocktakeDifference(tx, {
          tenantId: input.tenantId,
          warehouseId: stocktake.warehouseId,
          stocktakeId: stocktake.id,
          stocktakeItemId: item.id,
          postingCycle,
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
        await tx.warehouseStocktakeAdjustmentLine.create({
          data: {
            tenantId: input.tenantId, adjustmentId: adjustment.id, stocktakeItemId: item.id, productId: item.productId,
            quantity: dec(item.differenceQuantity!).abs(), inventoryUnit: item.inventoryUnit,
            unitCost: item.countedUnitCost!, amount: dec(item.differenceValue || 0).abs(), movementId: result.movement.id,
          },
        })
      }
    }
    const approvedBalances = productIds.length ? await tx.warehouseLedgerBalance.findMany({
      where: { tenantId: input.tenantId, warehouseId: stocktake.warehouseId, productId: { in: productIds } },
      select: { productId: true, postingSequence: true, rowVersion: true },
    }) : []
    if (approvedBalances.length !== items.length) throw fail('审核后库存凭据不完整，整单已回滚', 409)
    const approvedByProduct = new Map(approvedBalances.map(balance => [balance.productId, balance]))
    for (const item of items) {
      const approved = approvedByProduct.get(item.productId)!
      await tx.warehouseStocktakeItem.update({
        where: { id: item.id },
        data: { approvedPostingSequence: approved.postingSequence, approvedBalanceVersion: approved.rowVersion },
      })
    }
    const approvalRequestKey = `warehouse-stocktake-approve:${stocktake.id}:cycle:${postingCycle}`
    const approvalFingerprint = createHash('sha256').update(JSON.stringify({ stocktakeId: stocktake.id, postingCycle })).digest('hex')
    await tx.warehouseStocktakeLifecycleEvent.create({ data: {
      tenantId: input.tenantId, stocktakeId: stocktake.id, cycle: postingCycle, action: 'APPROVE',
      requestKey: approvalRequestKey, requestFingerprint: approvalFingerprint, actorId: input.userId,
      fromStatus: stocktake.status, toStatus: 'CONFIRMED', fromReviewStatus: stocktake.reviewStatus, toReviewStatus: 'UNREVIEWED',
      metadata: { itemCount: items.length },
    } })
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: finalReview ? '复审锁定总仓盘点' : '审核总仓盘点并生成盘盈盘亏', entityType: 'WarehouseStocktake', targetId: stocktake.id, target: stocktake.no } })
    const updated = await tx.warehouseStocktake.update({
      where: { id: stocktake.id, tenantId: input.tenantId, deletedAt: null },
      data: { status: 'CONFIRMED', reviewStatus: 'UNREVIEWED', postingCycle, auditedAt: effectiveAt, auditedById: input.userId, reviewedAt: null, reviewedById: null, reviewNote: null, rowVersion: { increment: 1 }, lastBatchItemId: input.batchItemId },
    })
    return { replayed: false, stocktake: updated }
  })
}

export async function generateFormalWarehouseStocktake(input: { tenantId: string; userId: string; id: string }) {
  return generateFormalWarehouseStocktakes({ ...input, sourceIds: [input.id], countScope: 'SELECTED' })
}

export async function generateFormalWarehouseStocktakes(input: { tenantId: string; userId: string; sourceIds: string[]; countScope: 'SELECTED' | 'DAILY' | 'WEEKLY' | 'ALL' }) {
  return serializable(async tx => {
    const sourceIds = [...new Set(input.sourceIds)]
    if (!sourceIds.length || sourceIds.length > 200) throw fail('请选择1至200张多人盘点子单', 400)
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktakes" WHERE "tenantId"=${input.tenantId} AND "deletedAt" IS NULL AND "id" IN (${Prisma.join(sourceIds)}) ORDER BY "id" FOR UPDATE`)
    const sources = await tx.warehouseStocktake.findMany({ where: { tenantId: input.tenantId, deletedAt: null, id: { in: sourceIds } }, include: detailInclude, orderBy: { id: 'asc' } })
    if (sources.length !== sourceIds.length || sources.some(source => source.documentType !== 'MULTI')) throw fail('只能汇总当前租户的多人盘点子单', 409)
    const existingIds = [...new Set(sources.flatMap(source => source.mergeSources.map(link => link.formalStocktakeId)))]
    if (existingIds.length) {
      if (existingIds.length !== 1 || sources.some(source => source.mergeSources[0]?.formalStocktakeId !== existingIds[0])) throw fail('所选子单已分别生成不同正式盘点单', 409)
      const existing = await tx.warehouseStocktake.findFirst({ where: { tenantId: input.tenantId, id: existingIds[0], deletedAt: null }, include: detailInclude })
      if (!existing) throw fail('已生成的盘点单不存在，请联系管理员核对', 409)
      if (existing.countScope !== input.countScope) throw fail('所选子单已按不同盘点范围生成正式盘点单', 409)
      return { replayed: true, stocktake: existing }
    }
    if (sources.some(source => source.status !== 'CONFIRMED' || source.sections.some(section => section.status !== 'SUBMITTED'))) throw fail('所选多人盘点子单必须全部已审核', 409)
    const source = sources[0]
    if (sources.some(row => row.warehouseId !== source.warehouseId)) throw fail('只能汇总同一仓库的多人盘点子单', 409)
    if (sources.some(row => row.countDate.getTime() !== source.countDate.getTime())) throw fail('只能汇总同一盘点日期的多人盘点子单', 409)
    const sourceItems = sources.flatMap(row => row.sections.flatMap(section => section.items))
    if (sourceItems.length > MAX_WAREHOUSE_STOCKTAKE_ITEMS) throw fail(`汇总后的正式盘点单最多包含${MAX_WAREHOUSE_STOCKTAKE_ITEMS}个商品`, 400)
    if (new Set(sourceItems.map(item => item.productId)).size !== sourceItems.length) throw fail('所选子单包含重复物品，请调整后再汇总', 409)
    if (input.countScope === 'ALL') {
      const enabled = await tx.product.findMany({
        where: stocktakeProductScope(input.tenantId),
        select: { id: true },
      })
      const sourceProductIds = new Set(sourceItems.map(item => item.productId))
      if (enabled.length !== sourceProductIds.size || enabled.some(product => !sourceProductIds.has(product.id))) {
        throw fail('全部盘点必须覆盖当前全部启用商品', 409)
      }
    }
    const generationKey = createHash('sha256')
      .update(JSON.stringify({ sourceIds: [...sourceIds].sort(), countScope: input.countScope }))
      .digest('hex')
      .slice(0, 48)

    const result = await tx.warehouseStocktake.create({
      data: {
        tenantId: source.tenantId,
        warehouseId: source.warehouseId,
        no: `WST-${source.countDate.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`,
        countDate: source.countDate,
        status: 'DRAFT',
        postingPolicy: 'REVIEW',
        documentType: 'FORMAL',
        requestKey: `generate:${generationKey}`,
        countScope: input.countScope,
        note: `来源${sources.length}张：${sources.slice(0,8).map(row => row.no).join('、')}${sources.length>8?'等':''}`.slice(0,500),
        createdById: input.userId,
        itemCount: sourceItems.length,
        countedCount: sourceItems.filter(item => item.countedQuantity != null).length,
        differenceCount: sourceItems.filter(item => item.differenceQuantity && !item.differenceQuantity.isZero()).length,
        totalBookValue: sources.reduce((sum,row)=>sum.plus(row.totalBookValue),ZERO),
        totalCountedValue: sources.reduce((sum,row)=>sum.plus(row.totalCountedValue),ZERO),
        totalDifferenceValue: sources.reduce((sum,row)=>sum.plus(row.totalDifferenceValue),ZERO),
      },
    })
    const section = await tx.warehouseStocktakeSection.create({ data: { tenantId: source.tenantId, stocktakeId: result.id, name: '汇总盘点', assignedToId: input.userId } })
    for (const row of sources) for (const sourceSection of row.sections) for (const item of sourceSection.items) {
        await tx.warehouseStocktakeItem.create({
          data: {
            tenantId: source.tenantId,
            stocktakeId: result.id,
            sectionId: section.id,
            productId: item.productId,
            productCodeSnapshot: item.productCodeSnapshot,
            productNameSnapshot: item.productNameSnapshot,
            productSpecSnapshot: item.productSpecSnapshot,
            categorySnapshot: item.categorySnapshot,
            storageLocationSnapshot: item.storageLocationSnapshot,
            additionSource: 'MERGED',
            inventoryUnit: item.inventoryUnit,
            unitPending: item.unitPending,
            bookQuantity: item.bookQuantity,
            bookValue: item.bookValue,
            averageUnitCost: item.averageUnitCost,
            bookBalanceVersion: item.bookBalanceVersion,
            countedUnitCost: item.countedUnitCost,
            countedQuantity: item.countedQuantity,
            countedValue: item.countedValue,
            differenceQuantity: item.differenceQuantity,
            differenceValue: item.differenceValue,
            reason: item.reason,
            sortOrder: sourceItems.findIndex(sourceItem => sourceItem.id === item.id),
          },
        })
    }
    await tx.warehouseStocktakeMergeSource.createMany({ data: sources.map(row => ({ tenantId: input.tenantId, sourceStocktakeId: row.id, formalStocktakeId: result.id })) })
    await tx.warehouseStocktake.updateMany({ where: { tenantId: input.tenantId, deletedAt: null, id: { in: sourceIds } }, data: { generatedStocktakeId: result.id, generatedAt: new Date(), rowVersion: { increment: 1 } } })
    for (const row of sources) await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: '多人盘点子单已汇总生成正式盘点单',
      entityType: 'WarehouseStocktake', targetId: row.id, target: row.no,
      metadata: { formalStocktakeId: result.id, formalStocktakeNo: result.no, sourceCount: sources.length },
    } })
    await tx.opLog.create({ data: { tenantId: input.tenantId, userId: input.userId, action: '多人盘点子单汇总生成正式盘点单', entityType: 'WarehouseStocktake', targetId: result.id, target: result.no, metadata: { sourceIds } } })
    return { replayed: false, stocktake: await tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId: input.tenantId, id: result.id, deletedAt: null }, include: detailInclude }) }
  })
}
