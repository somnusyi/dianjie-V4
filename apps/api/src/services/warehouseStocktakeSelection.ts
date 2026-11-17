import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { businessDateKey, businessDateOnlyRange, businessPeriodToDateRange, type BusinessPeriodUnit } from '../lib/businessTime'
import { supplyChainProductScope } from '../lib/supply-chain-product-scope'
import { auditWarehouseLedger } from './warehouseLedgerAudit'
import { MAX_WAREHOUSE_STOCKTAKE_ITEMS } from './warehouseStocktakeConstants'

export type WarehouseStocktakeCountScope = 'ALL' | 'DAILY' | 'WEEKLY' | 'SELECTED'
export type WarehouseStocktakeSelectionRule =
  | 'ALL_ENABLED'
  | 'HISTORICAL_MOVEMENT'
  | 'PERIOD_MOVEMENT_OR_OPENING'
  | 'BOOK_NONZERO_AS_OF'
  | 'FIXED_PLAN_PRODUCTS'
  | 'MANUAL_SELECTED'

export type WarehouseStocktakeSelectionInput = {
  tenantId: string
  warehouseId: string
  countDate: string
  countScope: WarehouseStocktakeCountScope
  planId?: string | null
  selectionRule?: WarehouseStocktakeSelectionRule | null
  periodUnit?: BusinessPeriodUnit | null
  manualProductIds?: string[]
}

const fail = (message: string, statusCode = 409, details?: Record<string, unknown>) => Object.assign(new Error(message), { statusCode, ...details })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const zero = new Prisma.Decimal(0)

function defaultRule(scope: WarehouseStocktakeCountScope) {
  if (scope === 'ALL') return { rule: 'ALL_ENABLED' as const, periodUnit: null }
  if (scope === 'DAILY') return { rule: 'PERIOD_MOVEMENT_OR_OPENING' as const, periodUnit: 'DAY' as const }
  if (scope === 'WEEKLY') return { rule: 'PERIOD_MOVEMENT_OR_OPENING' as const, periodUnit: 'WEEK' as const }
  return { rule: 'MANUAL_SELECTED' as const, periodUnit: null }
}

export function assertWarehouseStocktakeSelectionContract(
  countScope: WarehouseStocktakeCountScope,
  rule: WarehouseStocktakeSelectionRule,
  periodUnit: BusinessPeriodUnit | null,
) {
  if (countScope === 'ALL' && (rule !== 'ALL_ENABLED' || periodUnit)) {
    throw fail('全部盘点只能使用全部启用商品规则', 400)
  }
  if (countScope === 'DAILY' && (rule !== 'PERIOD_MOVEMENT_OR_OPENING' || periodUnit !== 'DAY')) {
    throw fail('日盘必须使用当日发生额与期初规则', 400)
  }
  if (countScope === 'WEEKLY' && (rule !== 'PERIOD_MOVEMENT_OR_OPENING' || periodUnit !== 'WEEK')) {
    throw fail('周盘必须使用本周发生额与期初规则', 400)
  }
  if (countScope === 'SELECTED') {
    if (rule === 'ALL_ENABLED') throw fail('全部启用商品规则必须使用全部盘点范围', 400)
    if (rule === 'PERIOD_MOVEMENT_OR_OPENING' && periodUnit !== 'MONTH') {
      throw fail('指定盘点的期间规则只能使用月；日、周请使用对应盘点范围', 400)
    }
  }
  if (rule === 'PERIOD_MOVEMENT_OR_OPENING' && !periodUnit) throw fail('期间发生额圈定必须指定日、周或月', 400)
  if (rule !== 'PERIOD_MOVEMENT_OR_OPENING' && periodUnit) throw fail('只有期间发生额圈定可以设置期间单位', 400)
}

function normalizeIds(ids: string[] | undefined) {
  const normalized = (ids || []).map(value => String(value || '').trim()).filter(Boolean)
  if (normalized.length !== new Set(normalized).size) throw fail('盘点商品不能重复', 400)
  return normalized.sort()
}

export async function resolveWarehouseStocktakeSelection(
  tx: Prisma.TransactionClient,
  input: WarehouseStocktakeSelectionInput,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.countDate)) throw fail('盘点日期无效', 400)
  if (input.countDate !== businessDateKey()) {
    throw fail('当前版本的账面快照只支持上海业务日当天盘点', 400)
  }
  const warehouse = await tx.warehouse.findFirst({
    where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true },
    select: { id: true, name: true, inventoryMode: true },
  })
  if (!warehouse) throw fail('总仓不存在或不属于当前租户', 404)
  const asOf = businessDateOnlyRange(input.countDate)
  const futurePhysicalMovement = await tx.warehouseLedgerMovement.findFirst({
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      effectiveAt: { gte: asOf.endExclusive },
      physicalDelta: { not: zero },
    },
    select: { id: true, productId: true, effectiveAt: true },
    orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }],
  })
  if (futurePhysicalMovement) {
    throw fail('当前仓库存在未来生效的实物库存流水，账面余额与今日口径不一致，不能创建盘点单', 409, {
      code: 'STOCKTAKE_SELECTION_FUTURE_MOVEMENT',
      firstMovementId: futurePhysicalMovement.id,
      firstEffectiveAt: futurePhysicalMovement.effectiveAt.toISOString(),
    })
  }

  const plan = input.planId ? await tx.warehouseStocktakePlan.findFirst({
    where: { tenantId: input.tenantId, id: input.planId, status: 'ENABLED' },
    include: { items: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  }) : null
  if (input.planId && !plan) throw fail('盘点方案不存在、已停用或不属于当前租户', 404)
  if (plan?.warehouseId && plan.warehouseId !== input.warehouseId) throw fail('盘点方案不适用于当前仓库', 409)

  if (plan && input.countScope !== plan.countScope) throw fail('请求的盘点范围与所选方案不一致', 409)
  if (plan && input.selectionRule !== undefined && input.selectionRule !== plan.selectionRule) {
    throw fail('请求的圈定规则与所选方案不一致', 409)
  }
  if (plan && input.periodUnit !== undefined && input.periodUnit !== plan.periodUnit) {
    throw fail('请求的期间单位与所选方案不一致', 409)
  }

  const resolvedScope = input.countScope
  const fallback = defaultRule(resolvedScope)
  const rule = (plan?.selectionRule ?? input.selectionRule ?? fallback.rule) as WarehouseStocktakeSelectionRule
  const periodUnit = (plan?.periodUnit ?? input.periodUnit ?? fallback.periodUnit) as BusinessPeriodUnit | null
  assertWarehouseStocktakeSelectionContract(resolvedScope, rule, periodUnit)
  if (rule === 'FIXED_PLAN_PRODUCTS' && !plan) throw fail('固定商品圈定必须选择盘点方案', 400)

  const historicalRule = ['HISTORICAL_MOVEMENT', 'PERIOD_MOVEMENT_OR_OPENING', 'BOOK_NONZERO_AS_OF'].includes(rule)
  const products = await tx.product.findMany({
    where: { tenantId: input.tenantId, status: 'ENABLED', ...supplyChainProductScope(input.tenantId) },
    select: { id: true, code: true, name: true, spec: true, category: true, unit: true, inventoryUnit: true, unitConversionStatus: true },
    orderBy: [{ category: 'asc' }, { code: 'asc' }, { id: 'asc' }],
  })
  const productById = new Map(products.map(product => [product.id, product]))
  const productIds = products.map(product => product.id)
  const policies = productIds.length ? await tx.warehouseStocktakeProductPolicy.findMany({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds } },
  }) : []
  const policyByProduct = new Map(policies.map(policy => [policy.productId, policy]))
  const automatic = ['ALL_ENABLED', 'HISTORICAL_MOVEMENT', 'PERIOD_MOVEMENT_OR_OPENING', 'BOOK_NONZERO_AS_OF'].includes(rule)
  const selectable = products.filter(product => {
    const policy = policyByProduct.get(product.id)
    return policy?.canCount !== false && (!automatic || policy?.defaultIncluded !== false)
  })
  const selectableIds = new Set(selectable.map(product => product.id))
  const period = rule === 'PERIOD_MOVEMENT_OR_OPENING'
    ? businessPeriodToDateRange(input.countDate, periodUnit!)
    : null

  if (historicalRule) {
    const audit = await auditWarehouseLedger(input.tenantId, tx as any, input.warehouseId)
    if (!audit.readyForStrict) {
      throw fail(`当前仓库台账完整性审计未通过，不能按历史流水自动圈定`, 409, {
        code: 'STOCKTAKE_SELECTION_LEDGER_NOT_READY',
        blockerCount: audit.blockerCount,
        firstIssue: audit.issues[0] || null,
      })
    }
  }

  const reasonByProduct = new Map<string, string>()
  let selectedIds: string[] = []
  if (rule === 'ALL_ENABLED') {
    selectedIds = [...selectableIds]
    selectedIds.forEach(id => reasonByProduct.set(id, 'ALL_ENABLED'))
  } else if (rule === 'HISTORICAL_MOVEMENT') {
    const rows = productIds.length ? await tx.warehouseLedgerMovement.findMany({
      where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds }, effectiveAt: { lt: asOf.endExclusive }, physicalDelta: { not: zero } },
      select: { productId: true }, distinct: ['productId'],
    }) : []
    selectedIds = rows.map(row => row.productId).filter(id => selectableIds.has(id))
    selectedIds.forEach(id => reasonByProduct.set(id, 'HISTORICAL_MOVEMENT'))
  } else if (rule === 'PERIOD_MOVEMENT_OR_OPENING') {
    const [opening, movements] = await Promise.all([
      productIds.length ? tx.warehouseLedgerMovement.groupBy({
        by: ['productId'],
        where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds }, effectiveAt: { lt: period!.start } },
        _sum: { physicalDelta: true },
      }) : [],
      productIds.length ? tx.warehouseLedgerMovement.findMany({
        where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds }, effectiveAt: { gte: period!.start, lt: period!.endExclusive }, physicalDelta: { not: zero } },
        select: { productId: true }, distinct: ['productId'],
      }) : [],
    ])
    const selected = new Set<string>()
    for (const row of opening) if (row._sum.physicalDelta && !row._sum.physicalDelta.isZero() && selectableIds.has(row.productId)) {
      selected.add(row.productId); reasonByProduct.set(row.productId, 'OPENING_NONZERO')
    }
    for (const row of movements) if (selectableIds.has(row.productId)) {
      selected.add(row.productId); reasonByProduct.set(row.productId, reasonByProduct.has(row.productId) ? 'OPENING_AND_PERIOD_MOVEMENT' : 'PERIOD_MOVEMENT')
    }
    selectedIds = [...selected]
  } else if (rule === 'BOOK_NONZERO_AS_OF') {
    const rows = productIds.length ? await tx.warehouseLedgerMovement.groupBy({
      by: ['productId'],
      where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: productIds }, effectiveAt: { lt: asOf.endExclusive } },
      _sum: { physicalDelta: true },
    }) : []
    selectedIds = rows.filter(row => row._sum.physicalDelta && !row._sum.physicalDelta.isZero() && selectableIds.has(row.productId)).map(row => row.productId)
    selectedIds.forEach(id => reasonByProduct.set(id, 'BOOK_NONZERO_AS_OF'))
  } else {
    const explicitIds = rule === 'FIXED_PLAN_PRODUCTS'
      ? normalizeIds(plan!.items.map(item => item.productId))
      : normalizeIds(input.manualProductIds)
    if (!explicitIds.length) throw fail(rule === 'FIXED_PLAN_PRODUCTS' ? '盘点方案未配置固定商品' : '请至少选择一个盘点商品', 400)
    for (const id of explicitIds) {
      const product = productById.get(id)
      if (!product) throw fail('方案或手工选择中存在已停用或越权商品', 409)
      const policy = policyByProduct.get(id)
      if (policy?.canCount === false) throw fail(`「${product.name}」已设置为禁止盘点：${policy.reason || '未填写原因'}`, 409)
    }
    selectedIds = explicitIds
    selectedIds.forEach(id => reasonByProduct.set(id, rule === 'FIXED_PLAN_PRODUCTS' ? 'FIXED_PLAN' : 'MANUAL_SELECTED'))
  }

  selectedIds = [...new Set(selectedIds)].sort()
  if (!selectedIds.length) throw fail('当前圈定规则没有匹配可盘点商品', 409)
  if (selectedIds.length > MAX_WAREHOUSE_STOCKTAKE_ITEMS) throw fail(`每张盘点单最多${MAX_WAREHOUSE_STOCKTAKE_ITEMS}项，请改用固定方案或手工分批`, 400)

  const fingerprintUniverse = automatic ? productIds : selectedIds
  const balances = fingerprintUniverse.length ? await tx.warehouseLedgerBalance.findMany({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: { in: fingerprintUniverse } },
    select: { productId: true, rowVersion: true, postingSequence: true, physicalQty: true },
    orderBy: { productId: 'asc' },
  }) : []
  const selectionFingerprint = hash({
    version: 1,
    warehouseId: input.warehouseId,
    countDate: input.countDate,
    countScope: resolvedScope,
    rule,
    periodUnit,
    windowStart: period?.start.toISOString() || null,
    windowEndExclusive: period?.endExclusive.toISOString() || null,
    plan: plan ? { id: plan.id, rowVersion: plan.rowVersion } : null,
    productUniverse: productIds,
    selectedIds,
    policies: policies.map(policy => ({ productId: policy.productId, rowVersion: policy.rowVersion, canCount: policy.canCount, defaultIncluded: policy.defaultIncluded })).sort((a, b) => a.productId.localeCompare(b.productId)),
    balances: balances.map(balance => ({ productId: balance.productId, rowVersion: balance.rowVersion, postingSequence: balance.postingSequence, physicalQty: balance.physicalQty.toFixed(6) })),
  })
  const selectedSet = new Set(selectedIds)
  return {
    warehouse,
    countScope: resolvedScope,
    selectionRule: rule,
    periodUnit,
    windowStart: period?.start || null,
    windowEndExclusive: period?.endExclusive || null,
    selectionFingerprint,
    plan: plan ? { id: plan.id, no: plan.no, name: plan.name, rowVersion: plan.rowVersion } : null,
    products: products.filter(product => selectedSet.has(product.id)).map(product => ({
      ...product,
      reasonCode: reasonByProduct.get(product.id) || rule,
      policy: policyByProduct.has(product.id) ? {
        canCount: policyByProduct.get(product.id)!.canCount,
        defaultIncluded: policyByProduct.get(product.id)!.defaultIncluded,
        reason: policyByProduct.get(product.id)!.reason,
      } : { canCount: true, defaultIncluded: true, reason: null },
    })),
  }
}

export async function previewWarehouseStocktakeSelection(input: WarehouseStocktakeSelectionInput) {
  return prisma.$transaction(tx => resolveWarehouseStocktakeSelection(tx, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 30_000,
  })
}
