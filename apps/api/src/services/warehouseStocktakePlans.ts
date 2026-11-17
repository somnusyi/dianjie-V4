import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { businessMonthKey } from '../lib/businessTime'
import { supplyChainProductScope } from '../lib/supply-chain-product-scope'
import { nextBusinessNo } from './purchaseOrderIntegrity'
import {
  assertWarehouseStocktakeSelectionContract,
  type WarehouseStocktakeCountScope,
  type WarehouseStocktakeSelectionRule,
} from './warehouseStocktakeSelection'

type PeriodUnit = 'DAY' | 'WEEK' | 'MONTH'
type PlanWrite = {
  name: string
  warehouseId?: string | null
  countScope: WarehouseStocktakeCountScope
  selectionRule: WarehouseStocktakeSelectionRule
  periodUnit?: PeriodUnit | null
  productIds?: string[]
  note?: string | null
}

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function assertRequestKey(requestKey: string, label: string) {
  if (!requestKey || requestKey.length < 8 || requestKey.length > 160) throw fail(`${label}请求编号无效`, 400)
}
const planInclude = {
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, code: true, name: true, spec: true, category: true, inventoryUnit: true, unit: true } } }, orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.WarehouseStocktakePlanInclude

async function serializablePlanWrite<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error: any) {
      const serializationConflict = error?.code === 'P2034'
        || (error?.code === 'P2010' && String(error?.meta?.code || '') === '40001')
        || error?.code === 'P2002'
      if (!serializationConflict) throw error
      if (attempt === 4) throw fail('盘点方案或商品政策正在被其他人更新，请刷新后重试', 409)
    }
  }
  throw fail('盘点方案并发更新失败', 409)
}

function normalizePlan(input: PlanWrite) {
  const name = String(input.name || '').trim()
  if (!name) throw fail('盘点方案名称不能为空', 400)
  const productIds = [...new Set((input.productIds || []).map(value => String(value || '').trim()).filter(Boolean))].sort()
  const periodUnit = input.periodUnit || null
  assertWarehouseStocktakeSelectionContract(input.countScope, input.selectionRule, periodUnit)
  if (input.selectionRule === 'FIXED_PLAN_PRODUCTS' && !productIds.length) throw fail('固定商品方案至少需要一个商品', 400)
  if (input.selectionRule !== 'FIXED_PLAN_PRODUCTS' && productIds.length) throw fail('只有固定商品方案可以配置商品清单', 400)
  if (input.selectionRule === 'MANUAL_SELECTED') throw fail('手工指定是单次盘点操作，不能保存为自动方案', 400)
  return { ...input, name, warehouseId: input.warehouseId || null, productIds, periodUnit, note: input.note?.trim() || null }
}

async function validatePlanReferences(tx: Prisma.TransactionClient, tenantId: string, input: ReturnType<typeof normalizePlan>) {
  if (input.warehouseId) {
    const warehouse = await tx.warehouse.findFirst({ where: { tenantId, id: input.warehouseId, isActive: true }, select: { id: true } })
    if (!warehouse) throw fail('方案仓库不存在或不属于当前租户', 404)
  }
  if (input.productIds.length) {
    const count = await tx.product.count({ where: { tenantId, id: { in: input.productIds }, status: 'ENABLED', ...supplyChainProductScope(tenantId) } })
    if (count !== input.productIds.length) throw fail('方案中存在已停用或越权商品', 409)
  }
}

export async function listWarehouseStocktakePlans(tenantId: string, enabledOnly = false) {
  return prisma.warehouseStocktakePlan.findMany({
    where: { tenantId, ...(enabledOnly ? { status: 'ENABLED' as const } : {}) },
    include: planInclude,
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }],
  })
}

export async function createWarehouseStocktakePlan(input: PlanWrite & { tenantId: string; userId: string; requestKey: string }) {
  assertRequestKey(input.requestKey, '盘点方案')
  const normalized = normalizePlan(input)
  const requestFingerprint = fingerprint({
    name: normalized.name, warehouseId: normalized.warehouseId, countScope: normalized.countScope,
    selectionRule: normalized.selectionRule, periodUnit: normalized.periodUnit, productIds: normalized.productIds, note: normalized.note,
  })
  return serializablePlanWrite(async tx => {
    const replay = await tx.warehouseStocktakePlan.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } }, include: planInclude,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw fail('同一请求编号不能用于不同盘点方案', 409)
      return { replayed: true, plan: replay }
    }
    await validatePlanReferences(tx, input.tenantId, normalized)
    const period = businessMonthKey()
    const no = await nextBusinessNo(tx, input.tenantId, 'WST_PLAN', period, 'WSP')
    const created = await tx.warehouseStocktakePlan.create({
      data: {
        tenantId: input.tenantId, no, name: normalized.name, warehouseId: normalized.warehouseId,
        countScope: normalized.countScope, selectionRule: normalized.selectionRule, periodUnit: normalized.periodUnit,
        note: normalized.note, requestKey: input.requestKey, requestFingerprint,
        createdById: input.userId, updatedById: input.userId,
      },
    })
    if (normalized.productIds.length) await tx.warehouseStocktakePlanItem.createMany({
      data: normalized.productIds.map((productId, sortOrder) => ({ tenantId: input.tenantId, planId: created.id, productId, sortOrder })),
    })
    const plan = await tx.warehouseStocktakePlan.findFirstOrThrow({
      where: { tenantId: input.tenantId, id: created.id }, include: planInclude,
    })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: `新建盘点方案 ${plan.name}`,
      entityType: 'WarehouseStocktakePlan', targetId: plan.id, target: plan.no,
      metadata: { countScope: plan.countScope, selectionRule: plan.selectionRule, productCount: plan.items.length },
    } })
    return { replayed: false, plan }
  })
}

export async function updateWarehouseStocktakePlan(input: PlanWrite & {
  tenantId: string; userId: string; id: string; rowVersion: number; status?: 'ENABLED' | 'DISABLED'; requestKey: string
}) {
  assertRequestKey(input.requestKey, '盘点方案更新')
  const normalized = normalizePlan(input)
  const requestFingerprint = fingerprint({
    id: input.id, rowVersion: input.rowVersion, status: input.status || null,
    name: normalized.name, warehouseId: normalized.warehouseId, countScope: normalized.countScope,
    selectionRule: normalized.selectionRule, periodUnit: normalized.periodUnit,
    productIds: normalized.productIds, note: normalized.note,
  })
  return serializablePlanWrite(async tx => {
    const replay = await tx.warehouseStocktakePlanChange.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw fail('同一请求编号不能用于不同盘点方案更新', 409)
      return replay.resultSnapshot as any
    }
    const existing = await tx.warehouseStocktakePlan.findFirst({ where: { tenantId: input.tenantId, id: input.id }, include: planInclude })
    if (!existing) throw fail('盘点方案不存在', 404)
    if (existing.rowVersion !== input.rowVersion) throw fail('盘点方案已更新，请刷新后重试', 409)
    const definitionUnchanged = existing.name === normalized.name
      && (existing.warehouseId || null) === normalized.warehouseId
      && existing.countScope === normalized.countScope
      && existing.selectionRule === normalized.selectionRule
      && (existing.periodUnit || null) === normalized.periodUnit
      && (existing.note || null) === normalized.note
      && JSON.stringify(existing.items.map(item => item.productId).sort()) === JSON.stringify(normalized.productIds)
    const unchangedDisable = input.status === 'DISABLED' && definitionUnchanged
    if (!unchangedDisable) await validatePlanReferences(tx, input.tenantId, normalized)
    await tx.warehouseStocktakePlanItem.deleteMany({ where: { tenantId: input.tenantId, planId: existing.id } })
    if (normalized.productIds.length) await tx.warehouseStocktakePlanItem.createMany({
      data: normalized.productIds.map((productId, sortOrder) => ({ tenantId: input.tenantId, planId: existing.id, productId, sortOrder })),
    })
    const changed = await tx.warehouseStocktakePlan.updateMany({
      where: { tenantId: input.tenantId, id: existing.id, rowVersion: input.rowVersion },
      data: {
        name: normalized.name, warehouseId: normalized.warehouseId, countScope: normalized.countScope,
        selectionRule: normalized.selectionRule, periodUnit: normalized.periodUnit, note: normalized.note,
        ...(input.status ? { status: input.status } : {}), updatedById: input.userId, rowVersion: { increment: 1 },
      },
    })
    if (changed.count !== 1) throw fail('盘点方案已更新，请刷新后重试', 409)
    const plan = await tx.warehouseStocktakePlan.findFirstOrThrow({ where: { tenantId: input.tenantId, id: existing.id }, include: planInclude })
    const resultSnapshot = JSON.parse(JSON.stringify(plan))
    await tx.warehouseStocktakePlanChange.create({ data: {
      tenantId: input.tenantId, planId: plan.id, requestKey: input.requestKey,
      requestFingerprint, resultSnapshot, resultRowVersion: plan.rowVersion, actorId: input.userId,
    } })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: `更新盘点方案 ${plan.name}${input.status === 'DISABLED' ? '（停用）' : input.status === 'ENABLED' ? '（启用）' : ''}`,
      entityType: 'WarehouseStocktakePlan', targetId: plan.id, target: plan.no,
      metadata: { beforeVersion: input.rowVersion, afterVersion: plan.rowVersion, productCount: plan.items.length },
    } })
    return resultSnapshot as typeof plan
  })
}

export async function listWarehouseStocktakeProductPolicies(tenantId: string, warehouseId: string) {
  const warehouse = await prisma.warehouse.findFirst({ where: { tenantId, id: warehouseId, isActive: true }, select: { id: true, name: true } })
  if (!warehouse) throw fail('总仓不存在或不属于当前租户', 404)
  const [products, policies] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId, status: 'ENABLED', ...supplyChainProductScope(tenantId) },
      select: { id: true, code: true, name: true, spec: true, category: true, inventoryUnit: true, unit: true },
      orderBy: [{ category: 'asc' }, { code: 'asc' }, { id: 'asc' }],
    }),
    prisma.warehouseStocktakeProductPolicy.findMany({ where: { tenantId, warehouseId } }),
  ])
  const byProduct = new Map(policies.map(policy => [policy.productId, policy]))
  return { warehouse, rows: products.map(product => ({
    product,
    ...(byProduct.get(product.id) || { id: null, canCount: true, defaultIncluded: true, reason: null, rowVersion: 0 }),
  })) }
}

export async function upsertWarehouseStocktakeProductPolicy(input: {
  tenantId: string; userId: string; warehouseId: string; productId: string
  canCount: boolean; defaultIncluded: boolean; reason?: string | null; rowVersion: number; requestKey: string
}) {
  const reason = input.reason?.trim() || null
  assertRequestKey(input.requestKey, '商品盘点政策')
  if (!input.canCount && (!reason || reason.length < 2)) throw fail('禁止盘点时必须填写至少2个字的原因', 400)
  const requestFingerprint = fingerprint({
    warehouseId: input.warehouseId,
    productId: input.productId,
    canCount: input.canCount,
    defaultIncluded: input.defaultIncluded,
    reason,
    rowVersion: input.rowVersion,
  })
  return serializablePlanWrite(async tx => {
    const replay = await tx.warehouseStocktakeProductPolicyChange.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw fail('同一请求编号不能用于不同商品盘点政策', 409)
      return replay.resultSnapshot
    }
    const [warehouse, product, existing] = await Promise.all([
      tx.warehouse.findFirst({ where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true }, select: { id: true, name: true } }),
      tx.product.findFirst({ where: { tenantId: input.tenantId, id: input.productId, status: 'ENABLED', ...supplyChainProductScope(input.tenantId) }, select: { id: true, name: true } }),
      tx.warehouseStocktakeProductPolicy.findUnique({ where: { tenantId_warehouseId_productId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId } } }),
    ])
    if (!warehouse || !product) throw fail('仓库或商品不存在、已停用或不属于当前租户', 404)
    if ((existing?.rowVersion || 0) !== input.rowVersion) throw fail('商品盘点政策已更新，请刷新后重试', 409)
    const policy = existing
      ? await tx.warehouseStocktakeProductPolicy.update({
        where: { id: existing.id },
        data: { canCount: input.canCount, defaultIncluded: input.defaultIncluded, reason, updatedById: input.userId, rowVersion: { increment: 1 } },
      })
      : await tx.warehouseStocktakeProductPolicy.create({ data: {
        tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId,
        canCount: input.canCount, defaultIncluded: input.defaultIncluded, reason, updatedById: input.userId, rowVersion: 1,
      } })
    const resultSnapshot = {
      id: policy.id,
      tenantId: policy.tenantId,
      warehouseId: policy.warehouseId,
      productId: policy.productId,
      canCount: policy.canCount,
      defaultIncluded: policy.defaultIncluded,
      reason: policy.reason,
      rowVersion: policy.rowVersion,
      updatedById: policy.updatedById,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    }
    await tx.warehouseStocktakeProductPolicyChange.create({ data: {
      tenantId: input.tenantId,
      policyId: policy.id,
      requestKey: input.requestKey,
      requestFingerprint,
      resultSnapshot,
      resultRowVersion: policy.rowVersion,
      actorId: input.userId,
    } })
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: `更新商品盘点政策 ${product.name}`,
      entityType: 'WarehouseStocktakeProductPolicy', targetId: policy.id, target: warehouse.name,
      metadata: { canCount: policy.canCount, defaultIncluded: policy.defaultIncluded, reason: policy.reason },
    } })
    return resultSnapshot
  })
}
