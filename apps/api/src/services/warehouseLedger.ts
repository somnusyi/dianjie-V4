import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { resolveProductFourUnits, type ProductInventoryUnitLike } from './inventoryUnits'
import { resolveTenantWarehouseId } from './defaultWarehouse'
import { physicalUnitFactor, sourceSpecMassFactor, sourceSpecPackageFactor } from './warehouseInventoryImport'
import { resolveSupplierIdsByNames } from './supplierAliases'
import { applyMarkupReprice } from './markupPricing'

const ZERO = new Prisma.Decimal(0)
const QTY_DP = 6
const VALUE_DP = 4
const COST_DP = 6

type Decimalish = Prisma.Decimal | string | number

export type DeliveryOutboundCostBreakdown = {
  total: string
  lineAmounts: Map<string, string>
}

export function summarizeDeliveryOutboundCostRows(
  rows: Array<{ id: string; sourceId: string; sourceLineId?: string | null; valueDelta: Decimalish }>,
  reversals: Array<{ sourceLineId: string; valueDelta: Decimalish }> = [],
) {
  const totals = new Map<string, Prisma.Decimal>()
  const lineTotals = new Map<string, Map<string, Prisma.Decimal>>()
  const movementSources = new Map<string, { deliveryId: string; sourceLineId: string | null }>()
  for (const row of rows) {
    const sourceLineId = row.sourceLineId ? String(row.sourceLineId) : null
    movementSources.set(row.id, { deliveryId: row.sourceId, sourceLineId })
    const valueDelta = new Prisma.Decimal(row.valueDelta || 0)
    const cost = valueDelta.isNegative() ? valueDelta.negated() : ZERO
    totals.set(row.sourceId, (totals.get(row.sourceId) || ZERO).plus(cost))
    if (sourceLineId) {
      const deliveryLines = lineTotals.get(row.sourceId) || new Map<string, Prisma.Decimal>()
      deliveryLines.set(sourceLineId, (deliveryLines.get(sourceLineId) || ZERO).plus(cost))
      lineTotals.set(row.sourceId, deliveryLines)
    }
  }
  for (const reversal of reversals) {
    const source = movementSources.get(reversal.sourceLineId)
    if (!source) continue
    const valueDelta = new Prisma.Decimal(reversal.valueDelta || 0)
    if (!valueDelta.isPositive()) continue
    totals.set(source.deliveryId, (totals.get(source.deliveryId) || ZERO).minus(valueDelta))
    if (source.sourceLineId) {
      const deliveryLines = lineTotals.get(source.deliveryId)
      if (deliveryLines) {
        deliveryLines.set(
          source.sourceLineId,
          (deliveryLines.get(source.sourceLineId) || ZERO).minus(valueDelta),
        )
      }
    }
  }

  return new Map([...totals].map(([deliveryId, total]) => [
    deliveryId,
    {
      total: Prisma.Decimal.max(ZERO, total).toFixed(2),
      lineAmounts: new Map([...(lineTotals.get(deliveryId) || new Map())].map(([sourceLineId, lineTotal]) => [
        sourceLineId,
        Prisma.Decimal.max(ZERO, lineTotal).toFixed(2),
      ])),
    },
  ]))
}

export function sumDeliveryOutboundCostRows(
  rows: Array<{ id: string; sourceId: string; sourceLineId?: string | null; valueDelta: Decimalish }>,
  reversals: Array<{ sourceLineId: string; valueDelta: Decimalish }> = [],
) {
  return new Map([...summarizeDeliveryOutboundCostRows(rows, reversals)].map(([deliveryId, breakdown]) => [
    deliveryId,
    breakdown.total,
  ]))
}

/** 历史配送单成本必须取发货当时冻结的总仓出库流水，不能用当前商品价格反算。 */
export async function deliveryOutboundCostBreakdowns(tenantId: string, deliveryIds: string[]) {
  const ids = [...new Set(deliveryIds.filter(Boolean))]
  const result = new Map<string, DeliveryOutboundCostBreakdown>()
  if (ids.length === 0) return result
  const rows = await prisma.warehouseLedgerMovement.findMany({
    where: {
      tenantId,
      type: 'ORDER_OUTBOUND',
      sourceType: 'DeliveryOrder',
      sourceId: { in: ids },
    },
    select: { id: true, sourceId: true, sourceLineId: true, valueDelta: true },
  })
  const reversals = await prisma.warehouseLedgerMovement.findMany({
    where: {
      tenantId,
      type: 'REVERSAL',
      sourceLineId: { in: rows.map(row => row.id) },
    },
    select: { sourceLineId: true, valueDelta: true },
  })
  return summarizeDeliveryOutboundCostRows(rows, reversals)
}

export async function deliveryOutboundCostAmounts(tenantId: string, deliveryIds: string[]) {
  const breakdowns = await deliveryOutboundCostBreakdowns(tenantId, deliveryIds)
  return new Map([...breakdowns].map(([deliveryId, breakdown]) => [deliveryId, breakdown.total]))
}

type LockedBalance = {
  id: string
  productId: string
  inventoryUnit: string
  physicalQty: Prisma.Decimal
  reservedQty: Prisma.Decimal
  inventoryValue: Prisma.Decimal
  averageUnitCost: Prisma.Decimal
}

export type FrozenOrderInventoryLine = {
  purchaseOrderItemId: string
  productId: string
  quantity: Decimalish
  shippedQty?: Decimalish
  productName?: string | null
  productUnit?: string | null
  orderUnitSnapshot?: string | null
  inventoryUnitSnapshot?: string | null
  inventoryUnitsPerOrderUnitSnapshot?: Decimalish | null
}

type ResolvedOrderLine = FrozenOrderInventoryLine & {
  originalQuantity: Prisma.Decimal
  originalUnit: string
  conversionFactor: Prisma.Decimal
  inventoryQuantity: Prisma.Decimal
  inventoryUnit: string
}

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function decimal(value: Decimalish, field: string) {
  try {
    const result = new Prisma.Decimal(value)
    if (result.isFinite()) return result
  } catch {
    // Normalized below.
  }
  throw businessError(`${field}无效`, 400)
}

function quantity(value: Decimalish, field: string) {
  const result = decimal(value, field).toDecimalPlaces(QTY_DP)
  if (result.lte(0)) throw businessError(`${field}必须大于0`, 400)
  return result
}

function nonnegativeQuantity(value: Decimalish, field: string) {
  const result = decimal(value, field).toDecimalPlaces(QTY_DP)
  if (result.lt(0)) throw businessError(`${field}不能小于0`, 400)
  return result
}

function factor(value: Decimalish | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const result = decimal(value, '单位换算系数').toDecimalPlaces(QTY_DP)
  return result.gt(0) ? result : null
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function nextAverageCost(value: Prisma.Decimal, physical: Prisma.Decimal, fallback: Prisma.Decimal) {
  if (physical.isZero()) return ZERO
  if (physical.lt(0)) return fallback.toDecimalPlaces(COST_DP)
  return value.div(physical).toDecimalPlaces(COST_DP)
}

async function serializableWithRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  timeout = 15_000,
): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout,
      })
    } catch (error: any) {
      // P2034 covers serializable write conflicts/deadlocks. P2002 is also
      // retryable inside this ledger because two first writes can race while
      // creating the same tenant/warehouse/product balance row. On retry the
      // committed balance or idempotent movement is visible and the request
      // deterministically continues or replays. Business duplicates such as
      // a reused batch number are detected explicitly after the retry.
      if (!['P2034', 'P2002'].includes(error?.code) || attempt === 4) throw error
    }
  }
  throw new Error('总仓库存事务重试失败')
}

/**
 * Convert a frozen order line into the warehouse inventory unit. Historical
 * lines with no four-unit snapshot are treated only as identity legacy lines;
 * a known unit mismatch without a frozen factor is rejected.
 */
export function resolveFrozenOrderInventoryLine(line: FrozenOrderInventoryLine): ResolvedOrderLine {
  // A delivery line with quantity 0 is still a real, visible line. Reservation
  // creation filters zero lines, while mutation/print flows keep the frozen
  // unit contract available for that line.
  const originalQuantity = nonnegativeQuantity(line.quantity, `${line.productName || '商品'}订货数量`)
  const originalUnit = String(line.orderUnitSnapshot || line.productUnit || '').trim()
  const inventoryUnit = String(line.inventoryUnitSnapshot || line.productUnit || originalUnit).trim()
  if (!originalUnit || !inventoryUnit) throw businessError(`${line.productName || '商品'}缺少冻结单位`, 400)

  let conversionFactor = factor(line.inventoryUnitsPerOrderUnitSnapshot)
  if (!conversionFactor && originalUnit === inventoryUnit) conversionFactor = new Prisma.Decimal(1)
  if (!conversionFactor) {
    throw businessError(`${line.productName || '商品'}缺少订货单位到库存单位的冻结换算，不能记总仓库存`, 409)
  }
  return {
    ...line,
    originalQuantity,
    originalUnit,
    conversionFactor,
    inventoryQuantity: originalQuantity.mul(conversionFactor).toDecimalPlaces(QTY_DP),
    inventoryUnit,
  }
}

/**
 * Close a reservation without ever writing fulfilledInventoryQty above the
 * reservation cap enforced by PostgreSQL. Extra shipped quantity is a normal
 * outbound delta, not extra fulfilment of the original reservation.
 */
export function warehouseReservationCloseState(
  reservedInput: Decimalish,
  shippedInput: Decimalish,
) {
  const reserved = quantity(reservedInput, '预占数量')
  const shipped = nonnegativeQuantity(shippedInput, '实发数量')
  const fulfilledInventoryQty = Prisma.Decimal.min(reserved, shipped).toDecimalPlaces(QTY_DP)
  const releasedInventoryQty = reserved.minus(fulfilledInventoryQty).toDecimalPlaces(QTY_DP)
  return {
    fulfilledInventoryQty,
    releasedInventoryQty,
    status: fulfilledInventoryQty.gt(0) ? 'CONSUMED' as const : 'RELEASED' as const,
  }
}

async function warehouseMode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  warehouseId: string,
) {
  const warehouse = await tx.warehouse.findFirst({
    where: { id: warehouseId, tenantId, isActive: true },
    select: { inventoryMode: true },
  })
  if (!warehouse) throw businessError('总仓不存在或已停用', 404)
  return warehouse.inventoryMode
}

export async function getWarehouseLedgerMode(tenantId: string) {
  const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
  const warehouse = await prisma.warehouse.findFirst({
    where: { id: warehouseId, tenantId, isActive: true },
    select: { inventoryMode: true },
  })
  if (!warehouse) throw businessError('总仓不存在或已停用', 404)
  return { warehouseId, inventoryMode: warehouse.inventoryMode }
}

async function lockBalances(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId: string
    products: Array<{ productId: string; inventoryUnit: string }>
  },
) {
  const byProduct = new Map<string, string>()
  for (const item of input.products) {
    const existing = byProduct.get(item.productId)
    if (existing && existing !== item.inventoryUnit) {
      throw businessError('同一商品在同一事务中出现不同库存单位', 400)
    }
    byProduct.set(item.productId, item.inventoryUnit)
  }
  const productIds = [...byProduct.keys()].sort()
  for (const productId of productIds) {
    await tx.warehouseLedgerBalance.upsert({
      where: {
        tenantId_warehouseId_productId: {
          tenantId: input.tenantId,
          warehouseId: input.warehouseId,
          productId,
        },
      },
      create: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        productId,
        inventoryUnit: byProduct.get(productId)!,
      },
      update: {},
    })
  }

  if (productIds.length === 0) return new Map<string, LockedBalance>()
  const rows = await tx.$queryRaw<LockedBalance[]>(Prisma.sql`
    SELECT "id", "productId", "inventoryUnit", "physicalQty", "reservedQty",
           "inventoryValue", "averageUnitCost"
    FROM "warehouse_ledger_balances"
    WHERE "tenantId" = ${input.tenantId}
      AND "warehouseId" = ${input.warehouseId}
      AND "productId" IN (${Prisma.join(productIds)})
    ORDER BY "productId"
    FOR UPDATE
  `)
  if (rows.length !== productIds.length) throw businessError('库存余额初始化失败，请重试', 409)
  for (const row of rows) {
    const expectedUnit = byProduct.get(row.productId)!
    if (row.inventoryUnit !== expectedUnit) {
      const canChange = row.physicalQty.isZero() && row.reservedQty.isZero() && row.inventoryValue.isZero()
      if (!canChange) throw businessError(`商品库存单位已从 ${row.inventoryUnit} 变为 ${expectedUnit}，请先执行单位迁移`, 409)
      await tx.warehouseLedgerBalance.update({ where: { id: row.id }, data: { inventoryUnit: expectedUnit } })
      row.inventoryUnit = expectedUnit
    }
  }
  return new Map(rows.map(row => [row.productId, row]))
}

async function persistBalance(
  tx: Prisma.TransactionClient,
  balance: LockedBalance,
  next: Pick<LockedBalance, 'physicalQty' | 'reservedQty' | 'inventoryValue' | 'averageUnitCost'>,
) {
  await tx.warehouseLedgerBalance.update({
    where: { id: balance.id },
    data: {
      physicalQty: next.physicalQty,
      reservedQty: next.reservedQty,
      inventoryValue: next.inventoryValue,
      averageUnitCost: next.averageUnitCost,
      rowVersion: { increment: 1 },
    },
  })
  Object.assign(balance, next)
}

async function allocateLotsFefo(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId: string
    productId: string
    movementId: string
    quantity: Prisma.Decimal
  },
) {
  let remaining = input.quantity
  if (remaining.lte(0)) return ZERO
  const lots = await tx.warehouseLedgerLot.findMany({
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      productId: input.productId,
      remainingQty: { gt: 0 },
    },
    orderBy: [
      { expiryDate: { sort: 'asc', nulls: 'last' } },
      { manufactureDate: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  })
  for (const lot of lots) {
    if (remaining.lte(0)) break
    const allocated = Prisma.Decimal.min(remaining, lot.remainingQty).toDecimalPlaces(QTY_DP)
    if (allocated.lte(0)) continue
    const value = allocated.mul(lot.inventoryUnitCost).toDecimalPlaces(VALUE_DP)
    const nextRemaining = lot.remainingQty.minus(allocated)
    await tx.warehouseLedgerLot.update({
      where: { id: lot.id },
      data: { remainingQty: nextRemaining, depletedAt: nextRemaining.isZero() ? new Date() : null },
    })
    await tx.warehouseLedgerLotAllocation.create({
      data: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        productId: input.productId,
        lotId: lot.id,
        movementId: input.movementId,
        quantity: allocated,
        unitCost: lot.inventoryUnitCost,
        value,
      },
    })
    remaining = remaining.minus(allocated)
  }
  return input.quantity.minus(remaining)
}

export type ManualWarehouseInboundInput = {
  tenantId: string
  userId: string
  productId: string
  purchaseQuantity: Decimalish
  totalAmount: Decimalish
  effectiveAt: Date
  idempotencyKey: string
  sourceName?: string | null
  supplierId?: string | null
  note?: string | null
  batchNo?: string | null
  manufactureDate?: Date | null
  expiryDate?: Date | null
}

export type BatchManualWarehouseInboundInput = {
  tenantId: string
  userId: string
  items: Array<{
    productId: string
    purchaseQuantity: Decimalish
    unitPrice: Decimalish
    /** 行金额（价税合计）。提供时作为权威金额入账（凑整场景），单价按 金额/数量 反算 */
    totalAmount?: Decimalish | null
    batchNo?: string | null
    manufactureDate?: Date | null
    expiryDate?: Date | null
  }>
  effectiveAt: Date
  idempotencyKey: string
  sourceName?: string | null
  supplierId?: string | null
  note?: string | null
}

/** Single-line manual inbound. It never writes Product.stock. */
export async function recordManualWarehouseInbound(input: ManualWarehouseInboundInput) {
  const warehouseId = await resolveTenantWarehouseId(prisma, input.tenantId, undefined)
  const product = await prisma.product.findFirst({
    where: { id: input.productId, tenantId: input.tenantId, status: 'ENABLED' },
    select: {
      id: true,
      name: true,
      unit: true,
      purchaseUnit: true,
      inventoryUnit: true,
      orderUnit: true,
      costUnit: true,
      inventoryUnitsPerPurchaseUnit: true,
      inventoryUnitsPerOrderUnit: true,
      inventoryUnitsPerCostUnit: true,
      unitConversionStatus: true,
    },
  })
  if (!product) throw businessError('商品不存在或已停用', 404)
  const contract = resolveProductFourUnits(product as ProductInventoryUnitLike)
  if (contract.status !== 'VERIFIED') throw businessError(`${product.name} 的四单位换算尚未核验，不能记真实入库`, 409)
  if (!contract.structured.purchase) throw businessError(`${product.name} 缺少采购单位到库存单位换算`, 409)
  const purchaseQuantity = quantity(input.purchaseQuantity, '入库数量')
  const totalAmount = decimal(input.totalAmount, '入库金额').toDecimalPlaces(VALUE_DP)
  if (totalAmount.lte(0)) throw businessError('入库金额必须大于0', 400)
  if (!input.effectiveAt || Number.isNaN(input.effectiveAt.getTime())) throw businessError('入库时间无效', 400)
  if (input.expiryDate && input.manufactureDate && input.expiryDate < input.manufactureDate) {
    throw businessError('到期日期不能早于生产日期', 400)
  }
  const conversionFactor = new Prisma.Decimal(contract.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(QTY_DP)
  const inventoryQuantity = purchaseQuantity.mul(conversionFactor).toDecimalPlaces(QTY_DP)
  const inventoryUnitCost = totalAmount.div(inventoryQuantity).toDecimalPlaces(COST_DP)
  const normalizedIdempotencyKey = `manual-inbound:${String(input.idempotencyKey).trim()}`
  const sourceRequestId = String(input.idempotencyKey).trim()
  if (!sourceRequestId || sourceRequestId.length > 80 || normalizedIdempotencyKey.length > 160) {
    throw businessError('入库幂等键无效', 400)
  }
  const requestFingerprint = fingerprint({
    productId: product.id,
    purchaseQuantity: purchaseQuantity.toFixed(QTY_DP),
    totalAmount: totalAmount.toFixed(VALUE_DP),
    effectiveAt: input.effectiveAt.toISOString(),
    sourceName: input.sourceName || null,
    supplierId: input.supplierId || null,
    note: input.note || null,
    batchNo: input.batchNo || null,
    manufactureDate: input.manufactureDate?.toISOString().slice(0, 10) || null,
    expiryDate: input.expiryDate?.toISOString().slice(0, 10) || null,
  })

  return serializableWithRetry(async tx => {
    const replay = await tx.warehouseLedgerMovement.findUnique({
      where: {
        tenantId_warehouseId_idempotencyKey: {
          tenantId: input.tenantId,
          warehouseId,
          idempotencyKey: normalizedIdempotencyKey,
        },
      },
      include: { createdLot: true },
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw businessError('同一幂等键不能用于不同的手工入库请求', 409)
      }
      return { replayed: true, movement: replay, warehouseId }
    }

    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: [{ productId: product.id, inventoryUnit: contract.inventoryUnit }],
    })
    // A concurrent request with the same key may have committed while this
    // transaction waited for the product balance lock. Recheck under the lock
    // so the loser returns the original result instead of surfacing P2002.
    const concurrentReplay = await tx.warehouseLedgerMovement.findUnique({
      where: {
        tenantId_warehouseId_idempotencyKey: {
          tenantId: input.tenantId,
          warehouseId,
          idempotencyKey: normalizedIdempotencyKey,
        },
      },
      include: { createdLot: true },
    })
    if (concurrentReplay) {
      if (concurrentReplay.requestFingerprint !== requestFingerprint) {
        throw businessError('同一幂等键不能用于不同的手工入库请求', 409)
      }
      return { replayed: true, movement: concurrentReplay, warehouseId }
    }
    const balance = balances.get(product.id)!
    const nextPhysical = balance.physicalQty.plus(inventoryQuantity)
    const nextValue = balance.inventoryValue.plus(totalAmount).toDecimalPlaces(VALUE_DP)
    const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: product.id,
        type: 'MANUAL_INBOUND',
        physicalDelta: inventoryQuantity,
        reservedDelta: ZERO,
        valueDelta: totalAmount,
        physicalAfter: nextPhysical,
        reservedAfter: balance.reservedQty,
        valueAfter: nextValue,
        averageUnitCostAfter: nextAverage,
        originalQuantity: purchaseQuantity,
        originalUnit: contract.purchaseUnit,
        conversionFactor,
        inventoryQuantity,
        inventoryUnit: contract.inventoryUnit,
        inventoryUnitCost,
        sourceType: 'WarehouseManualInbound',
        sourceId: sourceRequestId,
        sourceLineId: product.id,
        idempotencyKey: normalizedIdempotencyKey,
        requestFingerprint,
        effectiveAt: input.effectiveAt,
        note: input.note || null,
        sourceName: input.sourceName || null,
        supplierId: input.supplierId || null,
        createdById: input.userId,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: nextPhysical,
      reservedQty: balance.reservedQty,
      inventoryValue: nextValue,
      averageUnitCost: nextAverage,
    })
    // 比例加价：均价变化后按规则自动重算卖价（未启用比例加价的商品安静跳过）
    await applyMarkupReprice(tx, {
      tenantId: input.tenantId,
      productId: product.id,
      averageUnitCost: nextAverage,
      trigger: { type: 'WarehouseManualInbound', id: movement.id },
    })
    const batchNo = String(input.batchNo || `MI-${input.effectiveAt.toISOString().slice(0, 10).replaceAll('-', '')}-${movement.id.slice(-8)}`)
    if (input.batchNo) {
      const duplicateBatch = await tx.warehouseLedgerLot.findFirst({
        where: { tenantId: input.tenantId, warehouseId, productId: product.id, batchNo },
        select: { id: true },
      })
      if (duplicateBatch) throw businessError(`批次号已存在：${batchNo}`, 409)
    }
    const lot = await tx.warehouseLedgerLot.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: product.id,
        kind: 'MANUAL_INBOUND',
        batchNo,
        initialQty: inventoryQuantity,
        remainingQty: inventoryQuantity,
        inventoryUnit: contract.inventoryUnit,
        inventoryUnitCost,
        sourceName: input.sourceName || null,
        manufactureDate: input.manufactureDate || null,
        expiryDate: input.expiryDate || null,
        sourceMovementId: movement.id,
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: `总仓手工入库 ${product.name} ${purchaseQuantity.toFixed()} ${contract.purchaseUnit}`,
        target: movement.id,
        entityType: 'WarehouseLedgerMovement',
        targetId: movement.id,
        metadata: {
          warehouseId,
          productId: product.id,
          inventoryQuantity: inventoryQuantity.toFixed(QTY_DP),
          inventoryUnit: contract.inventoryUnit,
          totalAmount: totalAmount.toFixed(2),
          batchNo,
        },
      },
    })
    return { replayed: false, movement: { ...movement, createdLot: lot }, warehouseId }
  })
}

/**
 * Multi-line warehouse inbound. Every line is validated before the transaction
 * starts and the whole document commits atomically. One invalid line therefore
 * cannot leave a partially posted warehouse receipt.
 */
export async function recordBatchManualWarehouseInbound(input: BatchManualWarehouseInboundInput) {
  const warehouseId = await resolveTenantWarehouseId(prisma, input.tenantId, undefined)
  if (!input.effectiveAt || Number.isNaN(input.effectiveAt.getTime())) throw businessError('入库时间无效', 400)
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 200) {
    throw businessError('批量入库必须包含 1–200 行商品', 400)
  }
  const productIds = input.items.map(item => String(item.productId || '').trim())
  if (productIds.some(id => !id)) throw businessError('批量入库存在无效商品', 400)
  if (new Set(productIds).size !== productIds.length) throw businessError('同一商品不能在一张批量入库单中重复', 400)

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId: input.tenantId, status: 'ENABLED' },
    select: {
      id: true,
      name: true,
      unit: true,
      purchaseUnit: true,
      inventoryUnit: true,
      orderUnit: true,
      costUnit: true,
      inventoryUnitsPerPurchaseUnit: true,
      inventoryUnitsPerOrderUnit: true,
      inventoryUnitsPerCostUnit: true,
      unitConversionStatus: true,
    },
  })
  const productById = new Map(products.map(product => [product.id, product]))
  const lines = input.items.map((item, index) => {
    const product = productById.get(productIds[index])
    if (!product) throw businessError(`第 ${index + 1} 行商品不存在或已停用`, 404)
    const contract = resolveProductFourUnits(product as ProductInventoryUnitLike)
    if (contract.status !== 'VERIFIED') throw businessError(`${product.name} 的四单位换算尚未核验，不能记真实入库`, 409)
    if (!contract.structured.purchase) throw businessError(`${product.name} 缺少采购单位到库存单位换算`, 409)
    if (item.expiryDate && item.manufactureDate && item.expiryDate < item.manufactureDate) {
      throw businessError(`${product.name} 的到期日期不能早于生产日期`, 400)
    }
    const purchaseQuantity = quantity(item.purchaseQuantity, `${product.name}入库数量`)
    let unitPrice: Prisma.Decimal
    let totalAmount: Prisma.Decimal
    if (item.totalAmount !== null && item.totalAmount !== undefined) {
      // 凑整口径：录入行金额为权威值，单价反算（保留6位），保证与供应商账单分毫不差
      totalAmount = decimal(item.totalAmount, `${product.name}入库金额`).toDecimalPlaces(VALUE_DP)
      if (totalAmount.lte(0)) throw businessError(`${product.name}入库金额必须大于0`, 400)
      unitPrice = totalAmount.div(purchaseQuantity).toDecimalPlaces(COST_DP)
    } else {
      unitPrice = decimal(item.unitPrice, `${product.name}采购单价`).toDecimalPlaces(VALUE_DP)
      if (unitPrice.lte(0)) throw businessError(`${product.name}采购单价必须大于0`, 400)
      totalAmount = purchaseQuantity.mul(unitPrice).toDecimalPlaces(VALUE_DP)
    }
    if (totalAmount.gt('999999999.99')) throw businessError(`${product.name}入库金额超过系统上限`, 400)
    const conversionFactor = new Prisma.Decimal(contract.inventoryUnitsPerPurchaseUnit).toDecimalPlaces(QTY_DP)
    const inventoryQuantity = purchaseQuantity.mul(conversionFactor).toDecimalPlaces(QTY_DP)
    const inventoryUnitCost = totalAmount.div(inventoryQuantity).toDecimalPlaces(COST_DP)
    return {
      index,
      product,
      contract,
      purchaseQuantity,
      unitPrice,
      totalAmount,
      conversionFactor,
      inventoryQuantity,
      inventoryUnitCost,
      batchNo: String(item.batchNo || '').trim() || null,
      manufactureDate: item.manufactureDate || null,
      expiryDate: item.expiryDate || null,
    }
  })

  const sourceRequestId = String(input.idempotencyKey || '').trim()
  if (!sourceRequestId || sourceRequestId.length > 80) throw businessError('批量入库幂等键无效', 400)
  const requestFingerprint = fingerprint({
    items: lines.map(line => ({
      productId: line.product.id,
      purchaseQuantity: line.purchaseQuantity.toFixed(QTY_DP),
      unitPrice: line.unitPrice.toFixed(VALUE_DP),
      batchNo: line.batchNo,
      manufactureDate: line.manufactureDate?.toISOString().slice(0, 10) || null,
      expiryDate: line.expiryDate?.toISOString().slice(0, 10) || null,
    })),
    effectiveAt: input.effectiveAt.toISOString(),
    sourceName: input.sourceName || null,
    supplierId: input.supplierId || null,
    note: input.note || null,
  })
  const movementKey = (index: number) => `manual-inbound-batch:${sourceRequestId}:${index + 1}`
  if (movementKey(lines.length - 1).length > 160) throw businessError('批量入库幂等键过长', 400)

  return serializableWithRetry(async tx => {
    const findReplay = () => tx.warehouseLedgerMovement.findMany({
      where: {
        tenantId: input.tenantId,
        warehouseId,
        sourceType: 'WarehouseBatchManualInbound',
        sourceId: sourceRequestId,
      },
      orderBy: { sourceLineId: 'asc' },
      include: { createdLot: true },
    })
    const validateReplay = (rows: Awaited<ReturnType<typeof findReplay>>) => {
      if (rows.length === 0) return null
      if (rows.length !== lines.length || rows.some(row => row.requestFingerprint !== requestFingerprint)) {
        throw businessError('同一幂等键不能用于不同的批量入库请求', 409)
      }
      return { replayed: true, movements: rows, warehouseId }
    }
    const earlyReplay = validateReplay(await findReplay())
    if (earlyReplay) return earlyReplay

    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: lines.map(line => ({ productId: line.product.id, inventoryUnit: line.contract.inventoryUnit })),
    })
    const concurrentReplay = validateReplay(await findReplay())
    if (concurrentReplay) return concurrentReplay

    const customBatches = lines.filter(line => line.batchNo)
    if (customBatches.length) {
      const duplicate = await tx.warehouseLedgerLot.findFirst({
        where: {
          tenantId: input.tenantId,
          warehouseId,
          OR: customBatches.map(line => ({ productId: line.product.id, batchNo: line.batchNo! })),
        },
        select: { batchNo: true },
      })
      if (duplicate) throw businessError(`批次号已存在：${duplicate.batchNo}`, 409)
    }

    const movements = []
    for (const line of lines) {
      const balance = balances.get(line.product.id)!
      const nextPhysical = balance.physicalQty.plus(line.inventoryQuantity)
      const nextValue = balance.inventoryValue.plus(line.totalAmount).toDecimalPlaces(VALUE_DP)
      const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
      const movement = await tx.warehouseLedgerMovement.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: line.product.id,
          type: 'MANUAL_INBOUND',
          physicalDelta: line.inventoryQuantity,
          reservedDelta: ZERO,
          valueDelta: line.totalAmount,
          physicalAfter: nextPhysical,
          reservedAfter: balance.reservedQty,
          valueAfter: nextValue,
          averageUnitCostAfter: nextAverage,
          originalQuantity: line.purchaseQuantity,
          originalUnit: line.contract.purchaseUnit,
          conversionFactor: line.conversionFactor,
          inventoryQuantity: line.inventoryQuantity,
          inventoryUnit: line.contract.inventoryUnit,
          inventoryUnitCost: line.inventoryUnitCost,
          sourceType: 'WarehouseBatchManualInbound',
          sourceId: sourceRequestId,
          sourceLineId: `${String(line.index + 1).padStart(3, '0')}:${line.product.id}`,
          idempotencyKey: movementKey(line.index),
          requestFingerprint,
          effectiveAt: input.effectiveAt,
          note: input.note || null,
          sourceName: input.sourceName || null,
          supplierId: input.supplierId || null,
          createdById: input.userId,
        },
      })
      await persistBalance(tx, balance, {
        physicalQty: nextPhysical,
        reservedQty: balance.reservedQty,
        inventoryValue: nextValue,
        averageUnitCost: nextAverage,
      })
      // 比例加价：均价变化后按规则自动重算卖价
      await applyMarkupReprice(tx, {
        tenantId: input.tenantId,
        productId: line.product.id,
        averageUnitCost: nextAverage,
        trigger: { type: 'WarehouseBatchManualInbound', id: movement.id },
      })
      const batchNo = line.batchNo || `MB-${input.effectiveAt.toISOString().slice(0, 10).replaceAll('-', '')}-${movement.id.slice(-8)}`
      const lot = await tx.warehouseLedgerLot.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: line.product.id,
          kind: 'MANUAL_INBOUND',
          batchNo,
          initialQty: line.inventoryQuantity,
          remainingQty: line.inventoryQuantity,
          inventoryUnit: line.contract.inventoryUnit,
          inventoryUnitCost: line.inventoryUnitCost,
          sourceName: input.sourceName || null,
          manufactureDate: line.manufactureDate,
          expiryDate: line.expiryDate,
          sourceMovementId: movement.id,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          action: `总仓批量入库 ${line.product.name} ${line.purchaseQuantity.toFixed()} ${line.contract.purchaseUnit}`,
          target: sourceRequestId,
          entityType: 'WarehouseLedgerMovement',
          targetId: movement.id,
          metadata: {
            warehouseId,
            productId: line.product.id,
            inventoryQuantity: line.inventoryQuantity.toFixed(QTY_DP),
            inventoryUnit: line.contract.inventoryUnit,
            unitPrice: line.unitPrice.toFixed(4),
            totalAmount: line.totalAmount.toFixed(2),
            batchNo,
            documentLine: line.index + 1,
          },
        },
      })
      movements.push({ ...movement, createdLot: lot })
    }
    return { replayed: false, movements, warehouseId }
  })
}

export type BatchManualWarehouseOutboundInput = {
  tenantId: string
  userId: string
  items: Array<{
    productId: string
    /** 出库数量，按库存单位计 */
    inventoryQuantity: Decimalish
    /** 指定出库成本（不含税总额）；缺省按库存移动均价带出没变 */
    totalAmount?: Decimalish | null
    note?: string | null
  }>
  effectiveAt: Date
  idempotencyKey: string
  /** 出库原因/去向，如「门店拨补（美团 8.22 配送）」「报损」 */
  reason: string
  sourceName?: string | null
}

/**
 * 批量手工出库（2026-08-23，供应链切换期账目缺口补齐）。
 *
 * 背景：美团每日包记账依赖「前一日已确认基线」的导入单链条，该链条随
 * 快照确认端点下线而断裂；但总仓客观存在订单体系之外的出库——门店拨补、
 * 样品、报损、切换期历史补录。此函数提供有审计、有幂等、有 FEFO 批次
 * 分摊的手工出库通道。
 *
 * 语义与每日包出库对齐：type=ORDER_OUTBOUND、sourceType='WarehouseManualOutbound'
 * 区分来源；成本默认按移动均价带出，调用方可指定权威成本（如美团口径金额）；
 * 清零行尾差全部带出；STRICT 模式库存不足即整批拒绝。不回写 Product.stock。
 */
export async function recordBatchManualWarehouseOutbound(input: BatchManualWarehouseOutboundInput) {
  const { warehouseId, inventoryMode } = await getWarehouseLedgerMode(input.tenantId)
  if (!input.items.length) throw businessError('出库明细不能为空', 400)
  if (!input.effectiveAt || Number.isNaN(input.effectiveAt.getTime())) throw businessError('出库时间无效', 400)
  const reason = String(input.reason || '').trim()
  if (reason.length < 2) throw businessError('请填写出库原因/去向', 400)
  const sourceRequestId = String(input.idempotencyKey || '').trim()
  const normalizedIdempotencyKey = `manual-outbound:${sourceRequestId}`
  if (!sourceRequestId || sourceRequestId.length > 80 || normalizedIdempotencyKey.length > 160 - 40) {
    throw businessError('出库幂等键无效', 400)
  }
  const seen = new Set<string>()
  for (const item of input.items) {
    if (seen.has(item.productId)) throw businessError('同一商品不能重复添加', 400)
    seen.add(item.productId)
  }

  const products = await prisma.product.findMany({
    where: { tenantId: input.tenantId, id: { in: [...seen] }, status: 'ENABLED' },
    select: {
      id: true,
      name: true,
      unit: true,
      purchaseUnit: true,
      inventoryUnit: true,
      orderUnit: true,
      costUnit: true,
      inventoryUnitsPerPurchaseUnit: true,
      inventoryUnitsPerOrderUnit: true,
      inventoryUnitsPerCostUnit: true,
      unitConversionStatus: true,
    },
  })
  if (products.length !== seen.size) throw businessError('出库明细包含已停用或不存在的商品', 404)
  const productById = new Map(products.map(product => [product.id, product]))

  const lines = input.items.map((item, index) => {
    const product = productById.get(item.productId)!
    const contract = resolveProductFourUnits(product as ProductInventoryUnitLike)
    if (contract.status !== 'VERIFIED') throw businessError(`${product.name} 的四单位换算尚未核验，不能记真实出库`, 409)
    const inventoryQuantity = quantity(item.inventoryQuantity, `${product.name}出库数量`)
    const specifiedAmount = item.totalAmount === null || item.totalAmount === undefined
      ? null
      : decimal(item.totalAmount, `${product.name}出库成本`).toDecimalPlaces(VALUE_DP)
    if (specifiedAmount !== null && specifiedAmount.lte(0)) throw businessError(`${product.name}出库成本必须大于0`, 400)
    return { index, product, contract, inventoryQuantity, specifiedAmount, note: item.note || null }
  })

  return serializableWithRetry(async tx => {
    const lineKeys = lines.map(line => `${normalizedIdempotencyKey}:${line.product.id}`)
    const existing = await tx.warehouseLedgerMovement.findMany({
      where: { tenantId: input.tenantId, warehouseId, idempotencyKey: { in: lineKeys } },
      select: { id: true, idempotencyKey: true, productId: true, physicalDelta: true, valueDelta: true, inventoryUnit: true },
    })
    const existingByKey = new Map(existing.map(row => [row.idempotencyKey, row]))
    if (existing.length === lineKeys.length) {
      return {
        replayed: true,
        movements: existing.map(row => ({ id: row.id, productId: row.productId, physicalDelta: row.physicalDelta, valueDelta: row.valueDelta, inventoryUnit: row.inventoryUnit })),
        warehouseId,
      }
    }

    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: lines.map(line => ({ productId: line.product.id, inventoryUnit: line.contract.inventoryUnit })),
    })

    const movements: Array<{ id: string; productId: string; physicalDelta: Prisma.Decimal; valueDelta: Prisma.Decimal; inventoryUnit: string }> = []
    for (const line of lines) {
      const idempotencyKey = `${normalizedIdempotencyKey}:${line.product.id}`
      const replay = existingByKey.get(idempotencyKey)
      if (replay) { movements.push({ id: replay.id, productId: replay.productId, physicalDelta: replay.physicalDelta, valueDelta: replay.valueDelta, inventoryUnit: replay.inventoryUnit }); continue }
      const balance = balances.get(line.product.id)!
      if (inventoryMode === 'STRICT' && balance.physicalQty.lt(line.inventoryQuantity)) {
        throw businessError(`${line.product.name} 可用总仓库存不足，不能出库`, 409)
      }
      let costOut = line.specifiedAmount !== null
        ? line.specifiedAmount
        : line.inventoryQuantity.mul(balance.averageUnitCost).toDecimalPlaces(VALUE_DP)
      const nextPhysical = balance.physicalQty.minus(line.inventoryQuantity).toDecimalPlaces(QTY_DP)
      let nextValue = balance.inventoryValue.minus(costOut).toDecimalPlaces(VALUE_DP)
      if (nextPhysical.isZero()) { costOut = balance.inventoryValue; nextValue = ZERO }
      const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
      const movement = await tx.warehouseLedgerMovement.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: line.product.id,
          type: 'ORDER_OUTBOUND',
          physicalDelta: line.inventoryQuantity.negated(),
          reservedDelta: ZERO,
          valueDelta: costOut.negated(),
          physicalAfter: nextPhysical,
          reservedAfter: balance.reservedQty,
          valueAfter: nextValue,
          averageUnitCostAfter: nextAverage,
          originalQuantity: line.inventoryQuantity,
          originalUnit: line.contract.inventoryUnit,
          conversionFactor: new Prisma.Decimal(1),
          inventoryQuantity: line.inventoryQuantity,
          inventoryUnit: line.contract.inventoryUnit,
          inventoryUnitCost: line.inventoryQuantity.gt(0) ? costOut.div(line.inventoryQuantity).toDecimalPlaces(COST_DP) : ZERO,
          sourceType: 'WarehouseManualOutbound',
          sourceId: sourceRequestId,
          sourceLineId: line.product.id,
          idempotencyKey,
          requestFingerprint: fingerprint({
            productId: line.product.id,
            inventoryQuantity: line.inventoryQuantity.toFixed(QTY_DP),
            totalAmount: line.specifiedAmount?.toFixed(VALUE_DP) || null,
            effectiveAt: input.effectiveAt.toISOString(),
            reason,
            note: line.note,
          }),
          effectiveAt: input.effectiveAt,
          note: line.note ? `${reason}｜${line.note}` : reason,
          sourceName: input.sourceName || null,
          createdById: input.userId,
        },
      })
      await persistBalance(tx, balance, {
        physicalQty: nextPhysical,
        reservedQty: balance.reservedQty,
        inventoryValue: nextValue,
        averageUnitCost: nextAverage,
      })
      await allocateLotsFefo(tx, {
        tenantId: input.tenantId,
        warehouseId,
        productId: line.product.id,
        movementId: movement.id,
        quantity: line.inventoryQuantity,
      })
      await tx.opLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          action: `总仓批量出库 ${line.product.name} ${line.inventoryQuantity.toFixed()} ${line.contract.inventoryUnit}（${reason}）`,
          target: sourceRequestId,
          entityType: 'WarehouseLedgerMovement',
          targetId: movement.id,
          metadata: {
            warehouseId,
            productId: line.product.id,
            inventoryQuantity: line.inventoryQuantity.toFixed(QTY_DP),
            inventoryUnit: line.contract.inventoryUnit,
            costOut: costOut.toFixed(2),
            reason,
            documentLine: line.index + 1,
          },
        },
      })
      movements.push({
        id: movement.id,
        productId: line.product.id,
        physicalDelta: movement.physicalDelta,
        valueDelta: movement.valueDelta,
        inventoryUnit: line.contract.inventoryUnit,
      })
    }
    return { replayed: false, movements, warehouseId }
  })
}

export type WarehousePhysicalCountInput = {
  tenantId: string
  userId: string
  productId: string
  countedInventoryQuantity: Decimalish
  countedInventoryValue: Decimalish
  effectiveAt: Date
  idempotencyKey: string
  note?: string | null
}

/**
 * Reconcile one SKU to a formal physical count. Existing shadow lots are
 * depleted with allocations and replaced by one auditable count lot, while
 * the movement delta keeps the balance history mathematically continuous.
 */
export async function recordWarehousePhysicalCount(input: WarehousePhysicalCountInput) {
  const warehouseId = await resolveTenantWarehouseId(prisma, input.tenantId, undefined)
  const product = await prisma.product.findFirst({
    where: { id: input.productId, tenantId: input.tenantId, status: 'ENABLED' },
    select: {
      id: true,
      name: true,
      unit: true,
      purchaseUnit: true,
      inventoryUnit: true,
      orderUnit: true,
      costUnit: true,
      inventoryUnitsPerPurchaseUnit: true,
      inventoryUnitsPerOrderUnit: true,
      inventoryUnitsPerCostUnit: true,
      unitConversionStatus: true,
    },
  })
  if (!product) throw businessError('商品不存在或已停用', 404)
  const contract = resolveProductFourUnits(product as ProductInventoryUnitLike)
  if (contract.status !== 'VERIFIED') throw businessError(`${product.name} 的四单位换算尚未核验，不能执行实盘建账`, 409)
  const countedQuantity = nonnegativeQuantity(input.countedInventoryQuantity, '实盘库存数量')
  const countedValue = decimal(input.countedInventoryValue, '实盘库存金额').toDecimalPlaces(VALUE_DP)
  if (countedValue.lt(0)) throw businessError('实盘库存金额不能小于0', 400)
  if (countedQuantity.isZero() && !countedValue.isZero()) throw businessError('实盘数量为0时库存金额必须为0', 400)
  if (countedQuantity.gt(0) && countedValue.lte(0)) throw businessError('有实盘库存时必须填写大于0的库存金额', 400)
  if (!input.effectiveAt || Number.isNaN(input.effectiveAt.getTime())) throw businessError('实盘时间无效', 400)
  const rawKey = String(input.idempotencyKey).trim()
  const idempotencyKey = `physical-count:${rawKey}`
  if (!rawKey || rawKey.length > 80 || idempotencyKey.length > 160) throw businessError('实盘幂等键无效', 400)
  const requestFingerprint = fingerprint({
    productId: product.id,
    countedQuantity: countedQuantity.toFixed(QTY_DP),
    countedValue: countedValue.toFixed(VALUE_DP),
    effectiveAt: input.effectiveAt.toISOString(),
    note: input.note || null,
  })

  return serializableWithRetry(async tx => {
    const replayWhere = {
      tenantId_warehouseId_idempotencyKey: {
        tenantId: input.tenantId,
        warehouseId,
        idempotencyKey,
      },
    }
    const replay = await tx.warehouseLedgerMovement.findUnique({ where: replayWhere, include: { createdLot: true } })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw businessError('同一幂等键不能用于不同的实盘请求', 409)
      return { replayed: true, movement: replay, warehouseId }
    }
    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: [{ productId: product.id, inventoryUnit: contract.inventoryUnit }],
    })
    const concurrentReplay = await tx.warehouseLedgerMovement.findUnique({ where: replayWhere, include: { createdLot: true } })
    if (concurrentReplay) {
      if (concurrentReplay.requestFingerprint !== requestFingerprint) throw businessError('同一幂等键不能用于不同的实盘请求', 409)
      return { replayed: true, movement: concurrentReplay, warehouseId }
    }
    const balance = balances.get(product.id)!
    const mode = await warehouseMode(tx, input.tenantId, warehouseId)
    if (mode === 'STRICT' && countedQuantity.lt(balance.reservedQty)) {
      throw businessError('实盘数量低于活动预占，严格模式下必须先处理相关订单预占', 409)
    }
    const beforePhysical = new Prisma.Decimal(balance.physicalQty)
    const beforeValue = new Prisma.Decimal(balance.inventoryValue)
    const oldLots = await tx.warehouseLedgerLot.findMany({
      where: { tenantId: input.tenantId, warehouseId, productId: product.id, remainingQty: { gt: 0 } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const previousCount = await tx.warehouseLedgerMovement.findFirst({
      where: { tenantId: input.tenantId, warehouseId, productId: product.id, type: { in: ['OPENING_BALANCE', 'ADJUSTMENT'] } },
      select: { id: true },
    })
    const physicalDelta = countedQuantity.minus(beforePhysical).toDecimalPlaces(QTY_DP)
    const valueDelta = countedValue.minus(beforeValue).toDecimalPlaces(VALUE_DP)
    const averageUnitCost = countedQuantity.gt(0)
      ? countedValue.div(countedQuantity).toDecimalPlaces(COST_DP)
      : ZERO
    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: product.id,
        type: previousCount ? 'ADJUSTMENT' : 'OPENING_BALANCE',
        physicalDelta,
        reservedDelta: ZERO,
        valueDelta,
        physicalAfter: countedQuantity,
        reservedAfter: balance.reservedQty,
        valueAfter: countedValue,
        averageUnitCostAfter: averageUnitCost,
        originalQuantity: countedQuantity,
        originalUnit: contract.inventoryUnit,
        conversionFactor: new Prisma.Decimal(1),
        inventoryQuantity: countedQuantity,
        inventoryUnit: contract.inventoryUnit,
        inventoryUnitCost: averageUnitCost,
        sourceType: 'WarehousePhysicalCount',
        sourceId: rawKey,
        sourceLineId: product.id,
        idempotencyKey,
        requestFingerprint,
        effectiveAt: input.effectiveAt,
        note: input.note || (previousCount ? '总仓复盘调整' : '总仓实盘建立正式期初'),
        createdById: input.userId,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: countedQuantity,
      reservedQty: balance.reservedQty,
      inventoryValue: countedValue,
      averageUnitCost,
    })
    // 比例加价：实盘重设均价后按规则自动重算卖价
    await applyMarkupReprice(tx, {
      tenantId: input.tenantId,
      productId: product.id,
      averageUnitCost,
      trigger: { type: 'WarehousePhysicalCount', id: movement.id },
    })
    for (const lot of oldLots) {
      await tx.warehouseLedgerLot.update({
        where: { id: lot.id },
        data: { remainingQty: ZERO, depletedAt: input.effectiveAt },
      })
      await tx.warehouseLedgerLotAllocation.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: product.id,
          lotId: lot.id,
          movementId: movement.id,
          quantity: lot.remainingQty,
          unitCost: lot.inventoryUnitCost,
          value: lot.remainingQty.mul(lot.inventoryUnitCost).toDecimalPlaces(VALUE_DP),
        },
      })
    }
    let lot = null
    if (countedQuantity.gt(0)) {
      lot = await tx.warehouseLedgerLot.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: product.id,
          kind: previousCount ? 'ADJUSTMENT' : 'OPENING',
          batchNo: `${previousCount ? 'CA' : 'OB'}-${input.effectiveAt.toISOString().slice(0, 10).replaceAll('-', '')}-${movement.id.slice(-8)}`,
          initialQty: countedQuantity,
          remainingQty: countedQuantity,
          inventoryUnit: contract.inventoryUnit,
          inventoryUnitCost: averageUnitCost,
          sourceName: previousCount ? '总仓复盘' : '总仓实盘期初',
          sourceMovementId: movement.id,
        },
      })
    }
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: `${previousCount ? '总仓复盘调整' : '总仓实盘建账'} ${product.name} ${countedQuantity.toFixed()} ${contract.inventoryUnit}`,
        target: movement.id,
        entityType: 'WarehouseLedgerMovement',
        targetId: movement.id,
        metadata: {
          warehouseId,
          productId: product.id,
          beforeQuantity: beforePhysical.toFixed(QTY_DP),
          beforeValue: beforeValue.toFixed(VALUE_DP),
          countedQuantity: countedQuantity.toFixed(QTY_DP),
          physicalDelta: physicalDelta.toFixed(QTY_DP),
          countedValue: countedValue.toFixed(VALUE_DP),
          inventoryUnit: contract.inventoryUnit,
        },
      },
    })
    return { replayed: false, movement: { ...movement, createdLot: lot }, warehouseId }
  })
}

export async function reverseManualWarehouseInbound(input: {
  tenantId: string
  userId: string
  movementId: string
  reason: string
  idempotencyKey: string
}) {
  const warehouseId = await resolveTenantWarehouseId(prisma, input.tenantId, undefined)
  const rawKey = String(input.idempotencyKey).trim()
  const idempotencyKey = `manual-inbound-reversal:${rawKey}`
  if (!rawKey || rawKey.length > 80 || idempotencyKey.length > 160) throw businessError('冲销幂等键无效', 400)
  const reason = String(input.reason || '').trim()
  if (reason.length < 2 || reason.length > 240) throw businessError('冲销原因需为2至240个字符', 400)

  return serializableWithRetry(async tx => {
    const replay = await tx.warehouseLedgerMovement.findUnique({
      where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey } },
    })
    if (replay) return { replayed: true, movement: replay, warehouseId }
    let original = await tx.warehouseLedgerMovement.findFirst({
      where: { id: input.movementId, tenantId: input.tenantId, warehouseId },
      include: { createdLot: true, reversal: true, product: { select: { name: true } } },
    })
    if (!original) throw businessError('原入库流水不存在', 404)
    if (original.type !== 'MANUAL_INBOUND') throw businessError('只能冲销手工入库流水', 409)
    if (original.reversal) throw businessError('该手工入库已经冲销，不能重复操作', 409)
    if (!original.createdLot) throw businessError('原入库批次缺失，请先执行库存审计', 409)
    if (!original.createdLot.remainingQty.equals(original.createdLot.initialQty)) {
      throw businessError('该入库批次已有出库消耗，不能整笔冲销；请通过实盘调整处理差错', 409)
    }
    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: [{ productId: original.productId, inventoryUnit: original.inventoryUnit }],
    })
    const concurrentReplay = await tx.warehouseLedgerMovement.findUnique({
      where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey } },
    })
    if (concurrentReplay) return { replayed: true, movement: concurrentReplay, warehouseId }
    // The balance lock serializes this re-read with shipment FEFO allocation.
    // Never rely on the pre-lock lot snapshot when deciding whether a full
    // inbound reversal is still safe.
    original = await tx.warehouseLedgerMovement.findFirst({
      where: { id: input.movementId, tenantId: input.tenantId, warehouseId },
      include: { createdLot: true, reversal: true, product: { select: { name: true } } },
    })
    if (!original || original.type !== 'MANUAL_INBOUND' || !original.createdLot) {
      throw businessError('原手工入库或批次状态已变化，请刷新后重试', 409)
    }
    if (original.reversal) throw businessError('该手工入库已经冲销，不能重复操作', 409)
    if (!original.createdLot.remainingQty.equals(original.createdLot.initialQty)) {
      throw businessError('该入库批次已有出库消耗，不能整笔冲销；请通过实盘调整处理差错', 409)
    }
    const balance = balances.get(original.productId)!
    const nextPhysical = balance.physicalQty.minus(original.physicalDelta).toDecimalPlaces(QTY_DP)
    const nextValue = balance.inventoryValue.minus(original.valueDelta).toDecimalPlaces(VALUE_DP)
    const mode = await warehouseMode(tx, input.tenantId, warehouseId)
    if (mode === 'STRICT' && (nextPhysical.lt(0) || nextValue.lt(0))) {
      throw businessError('冲销后库存数量或金额将为负，请改走实盘调整', 409)
    }
    const normalizedValue = nextPhysical.isZero() ? ZERO : nextValue
    const actualValueDelta = normalizedValue.minus(balance.inventoryValue).toDecimalPlaces(VALUE_DP)
    const nextAverage = nextPhysical.isZero()
      ? ZERO
      : nextAverageCost(normalizedValue, nextPhysical, balance.averageUnitCost)
    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: original.productId,
        type: 'REVERSAL',
        physicalDelta: original.physicalDelta.negated(),
        reservedDelta: ZERO,
        valueDelta: actualValueDelta,
        physicalAfter: nextPhysical,
        reservedAfter: balance.reservedQty,
        valueAfter: normalizedValue,
        averageUnitCostAfter: nextAverage,
        originalQuantity: original.originalQuantity,
        originalUnit: original.originalUnit,
        conversionFactor: original.conversionFactor,
        inventoryQuantity: original.inventoryQuantity,
        inventoryUnit: original.inventoryUnit,
        inventoryUnitCost: original.inventoryUnitCost,
        sourceType: 'WarehouseManualInboundReversal',
        sourceId: original.id,
        sourceLineId: original.productId,
        idempotencyKey,
        requestFingerprint: fingerprint({ movementId: original.id, reason }),
        effectiveAt: new Date(),
        note: reason,
        createdById: input.userId,
        supplierId: original.supplierId,
        reversalOfId: original.id,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: nextPhysical,
      reservedQty: balance.reservedQty,
      inventoryValue: normalizedValue,
      averageUnitCost: nextAverage,
    })
    // 比例加价：冲回入库改变均价后按规则自动重算卖价
    await applyMarkupReprice(tx, {
      tenantId: input.tenantId,
      productId: original.productId,
      averageUnitCost: nextAverage,
      trigger: { type: 'WarehouseManualInboundReversal', id: movement.id },
    })
    await tx.warehouseLedgerLot.update({
      where: { id: original.createdLot.id },
      data: { remainingQty: ZERO, depletedAt: new Date() },
    })
    await tx.warehouseLedgerLotAllocation.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: original.productId,
        lotId: original.createdLot.id,
        movementId: movement.id,
        quantity: original.createdLot.remainingQty,
        unitCost: original.createdLot.inventoryUnitCost,
        value: original.createdLot.remainingQty.mul(original.createdLot.inventoryUnitCost).toDecimalPlaces(VALUE_DP),
      },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: `冲销总仓手工入库 ${original.product.name}：${reason}`,
        target: original.id,
        entityType: 'WarehouseLedgerMovement',
        targetId: movement.id,
        metadata: { originalMovementId: original.id, reversalMovementId: movement.id },
      },
    })
    return { replayed: false, movement, warehouseId }
  })
}

export async function reserveWarehouseLedgerForOrder(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    purchaseOrderId: string
    userId?: string | null
    effectiveAt?: Date
    lines: FrozenOrderInventoryLine[]
  },
) {
  // Serialize the async reservation projector with shipment/cancellation. A
  // stale ACCEPTED event must not recreate an ACTIVE reservation after the
  // order has already advanced.
  const lockedOrders = await tx.$queryRaw<Array<{ status: string; supplierId: string }>>(Prisma.sql`
    SELECT "status", "supplierId"
    FROM "purchase_orders"
    WHERE "id" = ${input.purchaseOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)
  if (lockedOrders.length !== 1) return
  const supplier = await tx.supplier.findFirst({
    where: { id: lockedOrders[0].supplierId, tenantId: input.tenantId },
    select: { sourceType: true },
  })
  if (supplier?.sourceType !== 'HEADQ_WAREHOUSE') return
  // A SHADOW task may start after a fast cancel or shipment. Current business
  // state wins over the stale ACCEPTED event so a late projector can never
  // recreate an ACTIVE reservation on a closed order.
  if (lockedOrders[0].status !== 'CONFIRMED') return
  const warehouseId = await resolveTenantWarehouseId(tx, input.tenantId, undefined)
  const mode = await warehouseMode(tx, input.tenantId, warehouseId)
  const lines = input.lines.map(resolveFrozenOrderInventoryLine).filter(line => line.inventoryQuantity.gt(0))
  const balances = await lockBalances(tx, {
    tenantId: input.tenantId,
    warehouseId,
    products: lines.map(line => ({ productId: line.productId, inventoryUnit: line.inventoryUnit })),
  })
  const effectiveAt = input.effectiveAt || new Date()

  for (const line of lines) {
    const existing = await tx.warehouseLedgerReservation.findUnique({
      where: { purchaseOrderItemId: line.purchaseOrderItemId },
    })
    if (existing) {
      if (existing.purchaseOrderId !== input.purchaseOrderId
        || !existing.inventoryQuantity.equals(line.inventoryQuantity)) {
        throw businessError('订单明细已有不一致的总仓预占记录', 409)
      }
      continue
    }
    const balance = balances.get(line.productId)!
    const available = balance.physicalQty.minus(balance.reservedQty)
    if (mode === 'STRICT' && available.lt(line.inventoryQuantity)) {
      throw businessError(`${line.productName || '商品'} 总仓可用库存不足：可用 ${available.toFixed(3)} ${line.inventoryUnit}，需要 ${line.inventoryQuantity.toFixed(3)} ${line.inventoryUnit}`)
    }
    const nextReserved = balance.reservedQty.plus(line.inventoryQuantity)
    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: line.productId,
        type: 'ORDER_RESERVED',
        physicalDelta: ZERO,
        reservedDelta: line.inventoryQuantity,
        valueDelta: ZERO,
        physicalAfter: balance.physicalQty,
        reservedAfter: nextReserved,
        valueAfter: balance.inventoryValue,
        averageUnitCostAfter: balance.averageUnitCost,
        originalQuantity: line.originalQuantity,
        originalUnit: line.originalUnit,
        conversionFactor: line.conversionFactor,
        inventoryQuantity: line.inventoryQuantity,
        inventoryUnit: line.inventoryUnit,
        inventoryUnitCost: balance.averageUnitCost,
        sourceType: 'PurchaseOrder',
        sourceId: input.purchaseOrderId,
        sourceLineId: line.purchaseOrderItemId,
        idempotencyKey: `order-reserve:${input.purchaseOrderId}:${line.purchaseOrderItemId}`,
        effectiveAt,
        createdById: input.userId || null,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: balance.physicalQty,
      reservedQty: nextReserved,
      inventoryValue: balance.inventoryValue,
      averageUnitCost: balance.averageUnitCost,
    })
    await tx.warehouseLedgerReservation.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: line.productId,
        purchaseOrderId: input.purchaseOrderId,
        purchaseOrderItemId: line.purchaseOrderItemId,
        originalQuantity: line.originalQuantity,
        originalUnit: line.originalUnit,
        conversionFactor: line.conversionFactor,
        inventoryQuantity: line.inventoryQuantity,
        inventoryUnit: line.inventoryUnit,
      },
    })
    void movement
  }
}

export async function postWarehouseReservationForOrder(input: {
  tenantId: string
  purchaseOrderId: string
  userId?: string | null
  effectiveAt?: Date
  lines: FrozenOrderInventoryLine[]
}) {
  return serializableWithRetry(tx => reserveWarehouseLedgerForOrder(tx, input))
}

export async function releaseWarehouseLedgerForOrder(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; purchaseOrderId: string; userId?: string | null; effectiveAt?: Date },
) {
  const reservations = await tx.warehouseLedgerReservation.findMany({
    where: { tenantId: input.tenantId, purchaseOrderId: input.purchaseOrderId, status: 'ACTIVE' },
    orderBy: [{ productId: 'asc' }, { purchaseOrderItemId: 'asc' }],
  })
  if (reservations.length === 0) return
  const warehouseId = reservations[0].warehouseId
  if (reservations.some(item => item.warehouseId !== warehouseId)) throw businessError('同一订单存在跨仓预占，无法释放', 409)
  const balances = await lockBalances(tx, {
    tenantId: input.tenantId,
    warehouseId,
    products: reservations.map(item => ({ productId: item.productId, inventoryUnit: item.inventoryUnit })),
  })
  const effectiveAt = input.effectiveAt || new Date()
  for (const reservation of reservations) {
    const balance = balances.get(reservation.productId)!
    const nextReserved = balance.reservedQty.minus(reservation.inventoryQuantity)
    if (nextReserved.lt(0)) throw businessError('总仓预占余额小于待释放数量，请先审计库存流水', 409)
    await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: reservation.productId,
        type: 'ORDER_RELEASED',
        physicalDelta: ZERO,
        reservedDelta: reservation.inventoryQuantity.negated(),
        valueDelta: ZERO,
        physicalAfter: balance.physicalQty,
        reservedAfter: nextReserved,
        valueAfter: balance.inventoryValue,
        averageUnitCostAfter: balance.averageUnitCost,
        originalQuantity: reservation.originalQuantity,
        originalUnit: reservation.originalUnit,
        conversionFactor: reservation.conversionFactor,
        inventoryQuantity: reservation.inventoryQuantity,
        inventoryUnit: reservation.inventoryUnit,
        inventoryUnitCost: balance.averageUnitCost,
        sourceType: 'PurchaseOrder',
        sourceId: input.purchaseOrderId,
        sourceLineId: reservation.purchaseOrderItemId,
        idempotencyKey: `order-release:${input.purchaseOrderId}:${reservation.purchaseOrderItemId}`,
        effectiveAt,
        createdById: input.userId || null,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: balance.physicalQty,
      reservedQty: nextReserved,
      inventoryValue: balance.inventoryValue,
      averageUnitCost: balance.averageUnitCost,
    })
    await tx.warehouseLedgerReservation.update({
      where: { id: reservation.id },
      data: { status: 'RELEASED', releasedAt: effectiveAt },
    })
  }
}

export async function postWarehouseReleaseForOrder(input: {
  tenantId: string
  purchaseOrderId: string
  userId?: string | null
  effectiveAt?: Date
}) {
  return serializableWithRetry(tx => releaseWarehouseLedgerForOrder(tx, input))
}

/**
 * 总仓的出库账只能有一个来源。
 *
 * 系统订货→发货链路(sourceType='DeliveryOrder')和美团每日数据包
 * (sourceType='MeituanDailyPackage')都会写 ORDER_OUTBOUND 并扣减物理库存，
 * 而同一批货在两边都会出现——美团那笔「配送发货出库」正是系统这笔发货。
 * 两条路同时开就是双重扣减，且没有任何地方会报错。
 *
 * 当前生产是美团数据包驱动(inventoryMode=OFF，系统发货链路未接总仓)，
 * 但那是「碰巧没触发」而不是「设计上不会」。这里让它失败得响亮:先落地的
 * 那条路径独占该仓库的出库账，另一条被明确拒绝并说明原因。
 */
/**
 * 出库来源互斥（商品级 + 纪元语义）：
 * - 纪元：最近一次 baselineApplied 基准之前的历史出库不参与判定——新基准把账重置，
 *   出库来源约定重新开始（否则 8.11 时代的美团包会永远拦住切换后的系统发货链路）。
 * - 商品级：只拦"同一商品被两条链路都记出库"。按对方门店拆行 + 已切店跳过后，
 *   两条链路记的是不同批货（未切店走美团包、已切店走系统发货），商品重叠是正常的；
 *   只有同商品真的两路都记（如门店过滤 miss）才会在此响亮报错。
 */
async function assertSingleOutboundLedgerSource(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId: string
    incoming: 'DeliveryOrder' | 'MeituanDailyPackage'
    products: string[]
  },
) {
  if (input.products.length === 0) return
  const conflicting = input.incoming === 'DeliveryOrder' ? 'MeituanDailyPackage' : 'DeliveryOrder'
  const baselines = await tx.warehouseInventoryImport.findMany({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, status: 'CONFIRMED' },
    orderBy: { snapshotDate: 'desc' },
    take: 5,
    select: { snapshotDate: true, metadata: true },
  })
  const latestBaseline = baselines.find(candidate => metadataRecord(candidate.metadata).baselineApplied === true)
  const epochStart = latestBaseline?.snapshotDate ?? new Date(0)
  const clash = await tx.warehouseLedgerMovement.findFirst({
    where: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      sourceType: conflicting,
      type: 'ORDER_OUTBOUND',
      productId: { in: input.products },
      effectiveAt: { gt: epochStart },
    },
    select: { productId: true, effectiveAt: true },
  })
  if (!clash) return
  const label = {
    DeliveryOrder: '系统订货发货链路',
    MeituanDailyPackage: '美团每日数据包',
  }
  throw businessError(
    `商品出库账在本基准周期内已由「${label[conflicting]}」记录（最近一笔 ${clash.effectiveAt.toISOString().slice(0, 10)}），`
    + `「${label[input.incoming]}」不能对同一商品再记一次——同一批货会被扣减两次。`
    + '要切换记账来源，请先冲销另一条路径已写入的流水。',
    409,
  )
}

export async function consumeWarehouseLedgerForShipment(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId?: string | null
    purchaseOrderId: string
    deliveryOrderId: string
    orderNo: string
    userId: string
    effectiveAt?: Date
    /** Post-shipment quantity/add-item mutations need a distinct append-only movement. */
    idempotencyKeySuffix?: string
    lines: FrozenOrderInventoryLine[]
  },
) {
  const orderScope = await tx.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, tenantId: input.tenantId },
    select: { supplier: { select: { sourceType: true } } },
  })
  if (!orderScope || orderScope.supplier.sourceType !== 'HEADQ_WAREHOUSE') {
    throw businessError('该订单不是总仓履约订单，不能记总仓出库', 409)
  }
  const warehouseId = await resolveTenantWarehouseId(tx, input.tenantId, input.warehouseId)
  const mode = await warehouseMode(tx, input.tenantId, warehouseId)
  const lines = input.lines.map(line => {
    const resolved = resolveFrozenOrderInventoryLine(line)
    const shipped = decimal(line.shippedQty ?? line.quantity, `${line.productName || '商品'}实发数量`).toDecimalPlaces(QTY_DP)
    if (shipped.lt(0)) throw businessError('实发数量不能为负', 400)
    return {
      ...resolved,
      shippedOriginalQuantity: shipped,
      shippedInventoryQuantity: shipped.mul(resolved.conversionFactor).toDecimalPlaces(QTY_DP),
    }
  })
  await assertSingleOutboundLedgerSource(tx, {
    tenantId: input.tenantId, warehouseId, incoming: 'DeliveryOrder',
    // A zero-quantity document line releases an existing reservation but does
    // not create an outbound ledger movement. Historical package outbounds
    // therefore must not block saving that line at zero.
    products: lines
      .filter(line => line.shippedInventoryQuantity.gt(0))
      .map(line => line.productId),
  })
  const balances = await lockBalances(tx, {
    tenantId: input.tenantId,
    warehouseId,
    products: lines.map(line => ({ productId: line.productId, inventoryUnit: line.inventoryUnit })),
  })
  const reservations = await tx.warehouseLedgerReservation.findMany({
    where: { purchaseOrderItemId: { in: lines.map(line => line.purchaseOrderItemId) } },
  })
  const reservationByItem = new Map(reservations.map(item => [item.purchaseOrderItemId, item]))
  const effectiveAt = input.effectiveAt || new Date()

  for (const line of lines) {
    const suffix = String(input.idempotencyKeySuffix || '').trim()
    const idempotencyKey = `delivery-outbound:${input.deliveryOrderId}:${line.purchaseOrderItemId}${suffix ? `:${suffix}` : ''}`
    if (idempotencyKey.length > 160) throw businessError('总仓出库幂等键过长', 400)
    const requestFingerprint = fingerprint({
      purchaseOrderId: input.purchaseOrderId,
      deliveryOrderId: input.deliveryOrderId,
      purchaseOrderItemId: line.purchaseOrderItemId,
      productId: line.productId,
      shippedOriginalQuantity: line.shippedOriginalQuantity.toFixed(QTY_DP),
      originalUnit: line.originalUnit,
      conversionFactor: line.conversionFactor.toFixed(QTY_DP),
      inventoryQuantity: line.shippedInventoryQuantity.toFixed(QTY_DP),
      inventoryUnit: line.inventoryUnit,
    })
    const existingMovement = await tx.warehouseLedgerMovement.findUnique({
      where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey } },
    })
    const reservation = reservationByItem.get(line.purchaseOrderItemId)
    if (reservation && (
      reservation.tenantId !== input.tenantId
      || reservation.warehouseId !== warehouseId
      || reservation.purchaseOrderId !== input.purchaseOrderId
      || reservation.productId !== line.productId
    )) {
      throw businessError('订单明细的总仓预占记录范围不一致', 409)
    }
    const ownReserved = reservation?.status === 'ACTIVE' ? reservation.inventoryQuantity : ZERO
    const balance = balances.get(line.productId)!
    if (existingMovement) {
      const sameLegacyPayload = existingMovement.type === 'ORDER_OUTBOUND'
        && existingMovement.productId === line.productId
        && existingMovement.sourceId === input.deliveryOrderId
        && existingMovement.sourceLineId === line.purchaseOrderItemId
        && new Prisma.Decimal(existingMovement.inventoryQuantity).equals(line.shippedInventoryQuantity)
        && new Prisma.Decimal(existingMovement.conversionFactor).equals(line.conversionFactor)
        && existingMovement.inventoryUnit === line.inventoryUnit
      if (
        (existingMovement.requestFingerprint && existingMovement.requestFingerprint !== requestFingerprint)
        || (!existingMovement.requestFingerprint && !sameLegacyPayload)
      ) throw businessError('同一发货幂等键不能用于不同的商品或数量', 409)

      // The SHADOW reservation projector can finish after the physical
      // outbound movement. Settle that late reservation here without creating
      // a second outbound or deducting physical stock twice.
      if (reservation?.status === 'ACTIVE') {
        const nextReserved = balance.reservedQty.minus(ownReserved)
        if (nextReserved.lt(0)) throw businessError('总仓预占余额异常，请先审计库存流水', 409)
        const close = warehouseReservationCloseState(
          reservation.inventoryQuantity,
          existingMovement.inventoryQuantity,
        )
        const lateReleaseKey = `late-reservation-release:${input.deliveryOrderId}:${line.purchaseOrderItemId}`
        const lateRelease = await tx.warehouseLedgerMovement.findUnique({
          where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey: lateReleaseKey } },
        })
        if (!lateRelease) {
          await tx.warehouseLedgerMovement.create({
            data: {
              tenantId: input.tenantId,
              warehouseId,
              productId: line.productId,
              type: 'ORDER_RELEASED',
              physicalDelta: ZERO,
              reservedDelta: ownReserved.negated(),
              valueDelta: ZERO,
              physicalAfter: balance.physicalQty,
              reservedAfter: nextReserved,
              valueAfter: balance.inventoryValue,
              averageUnitCostAfter: balance.averageUnitCost,
              originalQuantity: reservation.originalQuantity,
              originalUnit: reservation.originalUnit,
              conversionFactor: reservation.conversionFactor,
              inventoryQuantity: reservation.inventoryQuantity,
              inventoryUnit: reservation.inventoryUnit,
              inventoryUnitCost: balance.averageUnitCost,
              sourceType: 'PurchaseOrder',
              sourceId: input.purchaseOrderId,
              sourceLineId: line.purchaseOrderItemId,
              idempotencyKey: lateReleaseKey,
              requestFingerprint: fingerprint({ existingMovementId: existingMovement.id, reservationId: reservation.id }),
              effectiveAt,
              note: `结算延迟预占 ${input.orderNo}`,
              createdById: input.userId,
            },
          })
          await persistBalance(tx, balance, {
            physicalQty: balance.physicalQty,
            reservedQty: nextReserved,
            inventoryValue: balance.inventoryValue,
            averageUnitCost: balance.averageUnitCost,
          })
        }
        await tx.warehouseLedgerReservation.update({
          where: { id: reservation.id },
          data: {
            status: close.status,
            fulfilledInventoryQty: close.fulfilledInventoryQty,
            consumedAt: close.status === 'CONSUMED' ? effectiveAt : null,
            releasedAt: close.releasedInventoryQty.gt(0) || close.status === 'RELEASED' ? effectiveAt : null,
          },
        })
      } else if (!reservation && line.shippedInventoryQuantity.gt(0)) {
        // Heal an older or concurrently-posted outbound whose audit
        // reservation is missing. The outbound fingerprint above proves this
        // is the same delivery line, so creating the consumed fact is safe and
        // does not deduct stock a second time.
        await tx.warehouseLedgerReservation.create({
          data: {
            tenantId: input.tenantId,
            warehouseId,
            productId: line.productId,
            purchaseOrderId: input.purchaseOrderId,
            purchaseOrderItemId: line.purchaseOrderItemId,
            originalQuantity: line.shippedOriginalQuantity,
            originalUnit: line.originalUnit,
            conversionFactor: line.conversionFactor,
            inventoryQuantity: line.shippedInventoryQuantity,
            fulfilledInventoryQty: line.shippedInventoryQuantity,
            inventoryUnit: line.inventoryUnit,
            status: 'CONSUMED',
            consumedAt: effectiveAt,
          },
        })
      }
      continue
    }

    // Quantity zero remains a document line. It has no physical outbound, but
    // any original reservation must still be fully released.
    if (line.shippedInventoryQuantity.isZero()) {
      if (reservation?.status === 'ACTIVE') {
        const nextReserved = balance.reservedQty.minus(ownReserved)
        if (nextReserved.lt(0)) throw businessError('总仓预占余额异常，请先审计库存流水', 409)
        const releaseKey = `zero-shipment-release:${input.deliveryOrderId}:${line.purchaseOrderItemId}`
        await tx.warehouseLedgerMovement.create({
          data: {
            tenantId: input.tenantId,
            warehouseId,
            productId: line.productId,
            type: 'ORDER_RELEASED',
            physicalDelta: ZERO,
            reservedDelta: ownReserved.negated(),
            valueDelta: ZERO,
            physicalAfter: balance.physicalQty,
            reservedAfter: nextReserved,
            valueAfter: balance.inventoryValue,
            averageUnitCostAfter: balance.averageUnitCost,
            originalQuantity: reservation.originalQuantity,
            originalUnit: reservation.originalUnit,
            conversionFactor: reservation.conversionFactor,
            inventoryQuantity: reservation.inventoryQuantity,
            inventoryUnit: reservation.inventoryUnit,
            inventoryUnitCost: balance.averageUnitCost,
            sourceType: 'PurchaseOrder',
            sourceId: input.purchaseOrderId,
            sourceLineId: line.purchaseOrderItemId,
            idempotencyKey: releaseKey,
            requestFingerprint,
            effectiveAt,
            note: `零实发释放预占 ${input.orderNo}`,
            createdById: input.userId,
          },
        })
        await persistBalance(tx, balance, {
          physicalQty: balance.physicalQty,
          reservedQty: nextReserved,
          inventoryValue: balance.inventoryValue,
          averageUnitCost: balance.averageUnitCost,
        })
        await tx.warehouseLedgerReservation.update({
          where: { id: reservation.id },
          data: { status: 'RELEASED', fulfilledInventoryQty: ZERO, consumedAt: null, releasedAt: effectiveAt },
        })
      }
      continue
    }
    const protectedAvailable = balance.physicalQty.minus(balance.reservedQty.minus(ownReserved))
    if (mode === 'STRICT' && protectedAvailable.lt(line.shippedInventoryQuantity)) {
      throw businessError(`${line.productName || '商品'} 总仓可发库存不足：可发 ${protectedAvailable.toFixed(3)} ${line.inventoryUnit}，实发 ${line.shippedInventoryQuantity.toFixed(3)} ${line.inventoryUnit}`)
    }
    const nextReserved = balance.reservedQty.minus(ownReserved)
    if (nextReserved.lt(0)) throw businessError('总仓预占余额异常，请先审计库存流水', 409)
    let costOut = line.shippedInventoryQuantity.mul(balance.averageUnitCost).toDecimalPlaces(VALUE_DP)
    const nextPhysical = balance.physicalQty.minus(line.shippedInventoryQuantity)
    let nextValue = balance.inventoryValue.minus(costOut).toDecimalPlaces(VALUE_DP)
    if (nextPhysical.isZero()) {
      costOut = balance.inventoryValue
      nextValue = ZERO
    }
    const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: line.productId,
        type: 'ORDER_OUTBOUND',
        physicalDelta: line.shippedInventoryQuantity.negated(),
        reservedDelta: ownReserved.negated(),
        valueDelta: costOut.negated(),
        physicalAfter: nextPhysical,
        reservedAfter: nextReserved,
        valueAfter: nextValue,
        averageUnitCostAfter: nextAverage,
        originalQuantity: line.shippedOriginalQuantity,
        originalUnit: line.originalUnit,
        conversionFactor: line.conversionFactor,
        inventoryQuantity: line.shippedInventoryQuantity,
        inventoryUnit: line.inventoryUnit,
        inventoryUnitCost: balance.averageUnitCost,
        sourceType: 'DeliveryOrder',
        sourceId: input.deliveryOrderId,
        sourceLineId: line.purchaseOrderItemId,
        idempotencyKey,
        requestFingerprint,
        effectiveAt,
        note: `发货 ${input.orderNo}`,
        createdById: input.userId,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: nextPhysical,
      reservedQty: nextReserved,
      inventoryValue: nextValue,
      averageUnitCost: nextAverage,
    })
    const allocatedQuantity = await allocateLotsFefo(tx, {
      tenantId: input.tenantId,
      warehouseId,
      productId: line.productId,
      movementId: movement.id,
      quantity: line.shippedInventoryQuantity,
    })
    if (mode === 'STRICT' && allocatedQuantity.lt(line.shippedInventoryQuantity)) {
      throw businessError(`${line.productName || '商品'} 批次余额不足，不能在严格库存模式出库`, 409)
    }
    if (reservation?.status === 'ACTIVE') {
      const close = warehouseReservationCloseState(reservation.inventoryQuantity, line.shippedInventoryQuantity)
      await tx.warehouseLedgerReservation.update({
        where: { id: reservation.id },
        data: {
          status: close.status,
          fulfilledInventoryQty: close.fulfilledInventoryQty,
          consumedAt: close.status === 'CONSUMED' ? effectiveAt : null,
          releasedAt: close.releasedInventoryQty.gt(0) || close.status === 'RELEASED' ? effectiveAt : null,
        },
      })
    } else if (!reservation) {
      // Shipment-draft additions did not exist when the order was accepted,
      // so they have no ACTIVE reservation to close. The positive outbound is
      // nevertheless a completed audit fact and must get a consumed record;
      // later quantity/remove/restore mutations rely on this invariant.
      await tx.warehouseLedgerReservation.create({
        data: {
          tenantId: input.tenantId,
          warehouseId,
          productId: line.productId,
          purchaseOrderId: input.purchaseOrderId,
          purchaseOrderItemId: line.purchaseOrderItemId,
          originalQuantity: line.shippedOriginalQuantity,
          originalUnit: line.originalUnit,
          conversionFactor: line.conversionFactor,
          inventoryQuantity: line.shippedInventoryQuantity,
          fulfilledInventoryQty: line.shippedInventoryQuantity,
          inventoryUnit: line.inventoryUnit,
          status: 'CONSUMED',
          consumedAt: effectiveAt,
        },
      })
    }
  }
}

export async function postWarehouseShipment(input: {
  tenantId: string
  warehouseId?: string | null
  purchaseOrderId: string
  deliveryOrderId: string
  orderNo: string
  userId: string
  effectiveAt?: Date
  lines: FrozenOrderInventoryLine[]
}) {
  return serializableWithRetry(tx => consumeWarehouseLedgerForShipment(tx, input))
}

type DailyPackageInboundLine = {
  externalCode: string
  externalName: string
  sourceUnit: string
  sourceSpec?: string | null
  quantity: number
  amount: number
  suppliers?: string[]
}

type DailyPackageOutboundLine = {
  externalCode: string
  externalName: string
  sourceUnit: string
  baseUnit: string
  sourceSpec?: string | null
  quantity: number
  baseQuantity: number
  costAmount: number
  documents?: string[]
  stores?: string[]
  /** 对方门店（单行单店）：已切 V4 订货的门店行在记账前跳过，防止双记。 */
  store?: string
  /** 本组内最晚的单据审核时间，用作记账时点；缺失时回退到当天最后一刻。 */
  effectiveAt?: string | null
}

type DailyPackageMetadata = {
  packageDate?: string
  sourceSnapshotAt?: string | null
  ledger?: {
    inbound?: DailyPackageInboundLine[]
    outbound?: DailyPackageOutboundLine[]
  }
}

function metadataRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

function normalizedExternalCode(value: unknown) {
  return String(value || '').trim().toUpperCase()
}

function normalizedLedgerUnit(value: unknown) {
  const unit = String(value || '').trim().toLowerCase().replaceAll(' ', '')
  if (['千克', '公斤', 'kg', 'kgs'].includes(unit)) return 'kg'
  if (['克', 'g'].includes(unit)) return 'g'
  if (['升', 'l'].includes(unit)) return 'l'
  if (['毫升', 'ml'].includes(unit)) return 'ml'
  return unit
}

/**
 * Post a daily Meituan supply-chain package after a prior closing baseline.
 * The purchasing report becomes net inbound, the delivery report becomes
 * outbound, and the same day's inventory workbook remains a comparison fact.
 * No snapshot quantity is copied into the balance by this operation.
 */
export async function recordWarehouseDailyPackageLedger(input: {
  tenantId: string
  userId: string
  role: string
  importId: string
  rowVersion: number
}) {
  return serializableWithRetry(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-daily-package:${input.tenantId}:${input.importId}`}))`)
    const record = await tx.warehouseInventoryImport.findFirst({
      where: { id: input.importId, tenantId: input.tenantId },
      include: { items: { orderBy: { rowNumber: 'asc' } } },
    })
    if (!record) throw businessError('每日供应链导入单不存在', 404)
    if (record.status !== 'STAGED' || record.rowVersion !== input.rowVersion) {
      throw businessError('导入单状态已变化，请刷新后重试', 409)
    }
    const metadata = metadataRecord(record.metadata)
    if (metadata.dailyLedgerApplied === true) {
      return { replayed: true, importId: record.id, reconciliation: metadata.dailyLedgerReconciliation || null }
    }
    const dailyPackage = metadataRecord(metadata.dailyPackage) as DailyPackageMetadata
    const packageDate = String(dailyPackage.packageDate || '').trim()
    const inboundSource = Array.isArray(dailyPackage.ledger?.inbound) ? dailyPackage.ledger!.inbound! : []
    const outboundSource = Array.isArray(dailyPackage.ledger?.outbound) ? dailyPackage.ledger!.outbound! : []
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(packageDate) || (inboundSource.length === 0 && outboundSource.length === 0)) {
      throw businessError('该数据包缺少可记账的当日出入库明细，请重新上传原始 .7z 文件', 409)
    }

    const earlierImports = await tx.warehouseInventoryImport.findMany({
      where: {
        tenantId: input.tenantId,
        warehouseId: record.warehouseId,
        snapshotDate: { lt: record.snapshotDate },
        status: 'CONFIRMED',
      },
      orderBy: { snapshotDate: 'desc' },
      select: { id: true, no: true, snapshotDate: true, metadata: true },
    })
    const baseline = earlierImports.find(candidate => metadataRecord(candidate.metadata).baselineApplied === true)
    if (!baseline) throw businessError('请先把前一日（10 日）期末库存确认为库存基准，再写入 11 日流水', 409)
    const baselineDate = baseline.snapshotDate.toISOString().slice(0, 10)
    const expectedPrevious = new Date(`${packageDate}T00:00:00.000Z`)
    expectedPrevious.setUTCDate(expectedPrevious.getUTCDate() - 1)
    const expectedPreviousDate = expectedPrevious.toISOString().slice(0, 10)
    if (baselineDate !== expectedPreviousDate) {
      throw businessError(`当前最近基准为 ${baselineDate}，但 ${packageDate} 日流水要求 ${expectedPreviousDate} 日基准`, 409)
    }

    const itemByCode = new Map(record.items.map(item => [normalizedExternalCode(item.externalCode), item]))
    const requiredCodes = new Set([
      ...inboundSource.filter(line => Number(line.quantity) !== 0).map(line => normalizedExternalCode(line.externalCode)),
      ...outboundSource.filter(line => Number(line.baseQuantity || line.quantity) > 0).map(line => normalizedExternalCode(line.externalCode)),
    ])
    const externalMappings = await tx.productExternalCode.findMany({
      where: { tenantId: input.tenantId, source: 'MEITUAN', externalCode: { in: [...requiredCodes] } },
      select: { externalCode: true, productId: true },
    })
    const exactCodeProducts = await tx.product.findMany({
      where: { tenantId: input.tenantId, code: { in: [...requiredCodes] }, status: 'ENABLED' },
      select: { id: true, code: true },
    })
    const mappedProductIdByCode = new Map(externalMappings.map(mapping => [normalizedExternalCode(mapping.externalCode), mapping.productId]))
    const exactProductIdByCode = new Map(exactCodeProducts.map(product => [normalizedExternalCode(product.code), product.id]))
    const productIdByCode = new Map([...requiredCodes].map(code => [
      code,
      itemByCode.get(code)?.productId || mappedProductIdByCode.get(code) || exactProductIdByCode.get(code) || null,
    ]))
    const blocked: Array<{ code: string; message: string }> = []
    for (const code of requiredCodes) {
      const item = itemByCode.get(code)
      if (!productIdByCode.get(code)) blocked.push({ code, message: `${item?.externalName || code} 尚未绑定系统商品` })
    }
    if (blocked.length) throw Object.assign(businessError(`有 ${blocked.length} 个当日流水商品未完成映射`, 409), { blockingIssues: blocked })

    const productIds = [...new Set([...requiredCodes].map(code => productIdByCode.get(code)!))]
    const products = await tx.product.findMany({
      where: { tenantId: input.tenantId, id: { in: productIds }, status: 'ENABLED' },
      select: {
        id: true,
        name: true,
        unit: true,
        purchaseUnit: true,
        inventoryUnit: true,
        inventoryUnitsPerPurchaseUnit: true,
      },
    })
    const productById = new Map(products.map(product => [product.id, product]))
    if (products.length !== productIds.length) throw businessError('当日流水包含已停用或不存在的系统商品', 409)

    type ResolvedLine = {
      code: string
      productId: string
      productName: string
      inventoryUnit: string
      inventoryQuantity: Prisma.Decimal
      originalQuantity: Prisma.Decimal
      originalUnit: string
      conversionFactor: Prisma.Decimal
      amount: Prisma.Decimal
      sourceName: string | null
      supplierId: string | null
      note: string
      store?: string
    }
    const resolveInbound = (line: DailyPackageInboundLine): ResolvedLine | null => {
      const originalQuantity = decimal(line.quantity || 0, `${line.externalName}净收货数量`).toDecimalPlaces(QTY_DP)
      if (originalQuantity.isZero()) return null
      const code = normalizedExternalCode(line.externalCode)
      const item = itemByCode.get(code)
      const productId = productIdByCode.get(code)!
      const product = productById.get(productId)!
      const inventoryUnit = String(item?.inventoryUnit || product.inventoryUnit || product.unit || '').trim()
      const purchaseUnit = String(item?.purchaseUnit || product.purchaseUnit || product.unit || '').trim()
      const purchaseFactor = item?.conversionFactor || product.inventoryUnitsPerPurchaseUnit
      let conversionFactor = new Prisma.Decimal(1)
      if (normalizedLedgerUnit(line.sourceUnit) !== normalizedLedgerUnit(inventoryUnit)) {
        // 同量纲单位(kg→g、斤→g、l→ml)直接换算，换算率唯一且确定，优先于
        // 从规格字符串里猜。规格串缺失或写得不规范时不该卡住整批记账。
        const specificationFactor = physicalUnitFactor(line.sourceUnit, inventoryUnit)
          ?? sourceSpecMassFactor(line.sourceSpec || null, line.sourceUnit, inventoryUnit)
          ?? sourceSpecPackageFactor(line.sourceSpec || null, line.sourceUnit, inventoryUnit)
        if (specificationFactor != null) {
          conversionFactor = new Prisma.Decimal(specificationFactor).toDecimalPlaces(QTY_DP)
        } else if (normalizedLedgerUnit(line.sourceUnit) === normalizedLedgerUnit(purchaseUnit) && purchaseFactor) {
          conversionFactor = new Prisma.Decimal(purchaseFactor).toDecimalPlaces(QTY_DP)
        } else {
          throw businessError(`${line.externalName} 无法从 ${line.sourceUnit} 换算为库存单位 ${inventoryUnit}`, 409)
        }
      }
      return {
        code,
        productId,
        productName: product.name,
        inventoryUnit,
        inventoryQuantity: originalQuantity.abs().mul(conversionFactor).toDecimalPlaces(QTY_DP),
        originalQuantity: originalQuantity.abs(),
        originalUnit: line.sourceUnit,
        conversionFactor,
        amount: new Prisma.Decimal(line.amount || 0).abs().toDecimalPlaces(VALUE_DP),
        sourceName: Array.isArray(line.suppliers) ? line.suppliers.filter(Boolean).join('、').slice(0, 120) || null : null,
        supplierId: (() => {
          const names = Array.isArray(line.suppliers) ? line.suppliers.map(name => String(name || '').trim()).filter(Boolean) : []
          // 数据包按 商品×天 聚合：恰好一个供应商才能归一；多供应商行保留文本不猜
          return names.length === 1 ? supplierIdByName.get(names[0]) || null : null
        })(),
        note: originalQuantity.gt(0) ? `美团 ${packageDate} 采购净入库` : `美团 ${packageDate} 采购退货`,
      }
    }
    const resolveOutbound = (line: DailyPackageOutboundLine): ResolvedLine | null => {
      const code = normalizedExternalCode(line.externalCode)
      const item = itemByCode.get(code)
      const productId = productIdByCode.get(code)!
      const product = productById.get(productId)!
      const inventoryUnit = String(item?.inventoryUnit || product.inventoryUnit || product.unit || '').trim()
      const purchaseUnit = String(item?.purchaseUnit || product.purchaseUnit || product.unit || '').trim()
      const purchaseFactor = item?.conversionFactor || product.inventoryUnitsPerPurchaseUnit
      const baseQuantity = new Prisma.Decimal(line.baseQuantity || 0).toDecimalPlaces(QTY_DP)
      const originalQuantity = new Prisma.Decimal(line.quantity || 0).toDecimalPlaces(QTY_DP)
      let inventoryQuantity: Prisma.Decimal
      let conversionFactor: Prisma.Decimal
      let originalUnit: string
      if (baseQuantity.gt(0) && normalizedLedgerUnit(line.baseUnit) === normalizedLedgerUnit(inventoryUnit)) {
        inventoryQuantity = baseQuantity
        originalUnit = line.baseUnit
        conversionFactor = new Prisma.Decimal(1)
      } else if (originalQuantity.gt(0) && normalizedLedgerUnit(line.sourceUnit) === normalizedLedgerUnit(inventoryUnit)) {
        inventoryQuantity = originalQuantity
        originalUnit = line.sourceUnit
        conversionFactor = new Prisma.Decimal(1)
      } else if (originalQuantity.gt(0)
        && normalizedLedgerUnit(line.sourceUnit) === normalizedLedgerUnit(purchaseUnit)
        && purchaseFactor) {
        conversionFactor = new Prisma.Decimal(purchaseFactor).toDecimalPlaces(QTY_DP)
        inventoryQuantity = originalQuantity.mul(conversionFactor).toDecimalPlaces(QTY_DP)
        originalUnit = line.sourceUnit
      } else if (originalQuantity.gt(0)) {
        // 同量纲单位(kg→g、斤→g、l→ml)直接换算，换算率唯一且确定，优先于
        // 从规格字符串里猜。规格串缺失或写得不规范时不该卡住整批记账。
        const specificationFactor = physicalUnitFactor(line.sourceUnit, inventoryUnit)
          ?? sourceSpecMassFactor(line.sourceSpec || null, line.sourceUnit, inventoryUnit)
          ?? sourceSpecPackageFactor(line.sourceSpec || null, line.sourceUnit, inventoryUnit)
        if (specificationFactor == null) {
          throw businessError(`${line.externalName} 配送数量无法换算为库存单位 ${inventoryUnit}`, 409)
        }
        conversionFactor = new Prisma.Decimal(specificationFactor).toDecimalPlaces(QTY_DP)
        inventoryQuantity = originalQuantity.mul(conversionFactor).toDecimalPlaces(QTY_DP)
        originalUnit = line.sourceUnit
      } else {
        throw businessError(`${line.externalName} 配送数量无法换算为库存单位 ${inventoryUnit}`, 409)
      }
      if (inventoryQuantity.lte(0)) return null
      return {
      store: line.store || '',
        code,
        productId,
        productName: product.name,
        inventoryUnit,
        inventoryQuantity,
        originalQuantity: originalUnit === line.baseUnit ? baseQuantity : originalQuantity,
        originalUnit,
        conversionFactor,
        amount: new Prisma.Decimal(line.costAmount || 0).abs().toDecimalPlaces(VALUE_DP),
        sourceName: Array.isArray(line.stores) ? line.stores.filter(Boolean).join('、').slice(0, 120) || null : null,
        supplierId: null,
        note: `美团 ${packageDate} 配送出库${Array.isArray(line.documents) ? `（${line.documents.length} 单）` : ''}`,
      }
    }

    // 入库行供应商文本 → 主数据（精确名 + 别名表）；解析不了的保持 null 走"待认领"
    const inboundSupplierNames = inboundSource.flatMap(line =>
      Array.isArray(line.suppliers) ? line.suppliers.map(name => String(name || '').trim()).filter(Boolean) : [])
    const supplierIdByName = await resolveSupplierIdsByNames(input.tenantId, inboundSupplierNames)

    const resolvedInbound = inboundSource
      .map(source => ({ source, line: resolveInbound(source) }))
      .filter((item): item is { source: DailyPackageInboundLine; line: ResolvedLine } => Boolean(item.line))
    const purchaseReturns = resolvedInbound.filter(item => Number(item.source.quantity) < 0).map(item => item.line)
    const positiveInbound = resolvedInbound.filter(item => Number(item.source.quantity) > 0).map(item => item.line)
    const resolvedOutbound = outboundSource.map(resolveOutbound).filter((line): line is ResolvedLine => Boolean(line))
    const purchaseReturnLines = purchaseReturns
    // 已切店 = 在 V4 里下过采购单的门店：这些店的出库由系统发货链路记（SHADOW 自动），
    // 美团包里它们的行跳过，防止同一批货双记。跳过明细写入 metadata 供审计。
    const v4Stores = await tx.store.findMany({
      where: { tenantId: input.tenantId, status: 'ENABLED', purchaseOrders: { some: {} } },
      select: { name: true, posStoreAliases: true },
    })
    const v4StoreNames = new Set<string>()
    for (const store of v4Stores) {
      v4StoreNames.add(store.name.trim())
      for (const alias of store.posStoreAliases || []) v4StoreNames.add(String(alias).trim())
    }
    const skippedStoreLines: Array<{ store: string; code: string; name: string; quantity: number }> = []
    const outboundLines = [
      ...resolvedOutbound.filter(line => {
        if (line.store && v4StoreNames.has(line.store.trim())) {
          skippedStoreLines.push({ store: line.store, code: line.code, name: line.productName, quantity: Number(line.originalQuantity) })
          return false
        }
        return true
      }),
      ...purchaseReturnLines,
    ]
    // 出库行携带了本组内最晚的单据审核时间，用它做记账时点。
    const outboundEffectiveAtByCode = new Map(
      outboundSource.map(line => [normalizedExternalCode(line.externalCode), line.effectiveAt]),
    )
    const allLines = [...positiveInbound, ...outboundLines]
    const snapshotBalanceProducts = record.items
      .filter((item): item is typeof item & { productId: string; inventoryUnit: string } => Boolean(item.productId && item.inventoryUnit))
      .map(item => ({ productId: item.productId, inventoryUnit: item.inventoryUnit }))
    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId: record.warehouseId,
      products: [
        ...allLines.map(line => ({ productId: line.productId, inventoryUnit: line.inventoryUnit })),
        ...snapshotBalanceProducts,
      ],
    })
    await assertSingleOutboundLedgerSource(tx, {
      tenantId: input.tenantId, warehouseId: record.warehouseId, incoming: 'MeituanDailyPackage',
      products: outboundLines.map(line => line.productId),
    })
    const mode = await warehouseMode(tx, input.tenantId, record.warehouseId)
    // 归属时点用行级的单据审核时间，写死当天 23:59 会让当晚审核的流水错位。
    // 取不到审核时间的行才回退到当天最后一刻。
    const packageFallbackAt = new Date(`${packageDate}T23:59:00+08:00`)
    const lineEffectiveAt = (raw: string | null | undefined) => {
      if (!raw) return packageFallbackAt
      const parsed = new Date(String(raw).includes('T') ? String(raw) : `${String(raw).replace(' ', 'T')}+08:00`)
      return Number.isNaN(parsed.getTime()) ? packageFallbackAt : parsed
    }
    const effectiveAt = packageFallbackAt
    const movementIds: string[] = []

    for (const [index, line] of positiveInbound.entries()) {
      const idempotencyKey = `daily-package:${record.id}:in:${line.productId}`
      const existing = await tx.warehouseLedgerMovement.findUnique({
        where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId: record.warehouseId, idempotencyKey } },
      })
      if (existing) { movementIds.push(existing.id); continue }
      const balance = balances.get(line.productId)!
      const valueIn = line.amount
      const unitCost = line.inventoryQuantity.gt(0) ? valueIn.div(line.inventoryQuantity).toDecimalPlaces(COST_DP) : ZERO
      const nextPhysical = balance.physicalQty.plus(line.inventoryQuantity)
      const nextValue = balance.inventoryValue.plus(valueIn).toDecimalPlaces(VALUE_DP)
      const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
      const movement = await tx.warehouseLedgerMovement.create({ data: {
        tenantId: input.tenantId, warehouseId: record.warehouseId, productId: line.productId,
        type: 'MANUAL_INBOUND', physicalDelta: line.inventoryQuantity, reservedDelta: ZERO, valueDelta: valueIn,
        physicalAfter: nextPhysical, reservedAfter: balance.reservedQty, valueAfter: nextValue, averageUnitCostAfter: nextAverage,
        originalQuantity: line.originalQuantity, originalUnit: line.originalUnit, conversionFactor: line.conversionFactor,
        inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.inventoryUnit, inventoryUnitCost: unitCost,
        sourceType: 'MeituanDailyPackage', sourceId: record.id, sourceLineId: `IN:${line.code}`,
        idempotencyKey, requestFingerprint: fingerprint({ packageDate, line, direction: 'IN' }), effectiveAt,
        note: line.note, sourceName: line.sourceName, supplierId: line.supplierId, createdById: input.userId,
      } })
      await persistBalance(tx, balance, { physicalQty: nextPhysical, reservedQty: balance.reservedQty, inventoryValue: nextValue, averageUnitCost: nextAverage })
      // 比例加价：美团每日包入库改变均价后按规则自动重算卖价
      await applyMarkupReprice(tx, {
        tenantId: input.tenantId,
        productId: line.productId,
        averageUnitCost: nextAverage,
        trigger: { type: 'MeituanDailyPackage', id: movement.id },
      })
      await tx.warehouseLedgerLot.create({ data: {
        tenantId: input.tenantId, warehouseId: record.warehouseId, productId: line.productId, kind: 'MANUAL_INBOUND',
        batchNo: `DP-${packageDate.replaceAll('-', '')}-${record.id.slice(-6)}-${line.productId.slice(-6)}`,
        initialQty: line.inventoryQuantity, remainingQty: line.inventoryQuantity, inventoryUnit: line.inventoryUnit,
        inventoryUnitCost: unitCost, sourceName: line.sourceName, sourceMovementId: movement.id,
      } })
      movementIds.push(movement.id)
    }

    for (const [outboundIndex, line] of outboundLines.entries()) {
      const direction = purchaseReturns.includes(line) ? 'RETURN' : 'OUT'
      // 幂等键含行序号：出库行按 商品×对方门店 拆分后，同一商品可能有多行（发给不同门店）
      const idempotencyKey = `daily-package:${record.id}:${direction.toLowerCase()}:${line.productId}:${outboundIndex}`
      const existing = await tx.warehouseLedgerMovement.findUnique({
        where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId: record.warehouseId, idempotencyKey } },
      })
      if (existing) { movementIds.push(existing.id); continue }
      const balance = balances.get(line.productId)!
      if (mode === 'STRICT' && balance.physicalQty.lt(line.inventoryQuantity)) {
        throw businessError(`${line.productName} 可用总仓库存不足，不能写入 ${packageDate} 日出库`, 409)
      }
      let costOut = line.amount.gt(0) ? line.amount : line.inventoryQuantity.mul(balance.averageUnitCost).toDecimalPlaces(VALUE_DP)
      const nextPhysical = balance.physicalQty.minus(line.inventoryQuantity)
      let nextValue = balance.inventoryValue.minus(costOut).toDecimalPlaces(VALUE_DP)
      if (nextPhysical.isZero()) { costOut = balance.inventoryValue; nextValue = ZERO }
      const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)
      const movement = await tx.warehouseLedgerMovement.create({ data: {
        tenantId: input.tenantId, warehouseId: record.warehouseId, productId: line.productId,
        type: 'ORDER_OUTBOUND', physicalDelta: line.inventoryQuantity.negated(), reservedDelta: ZERO, valueDelta: costOut.negated(),
        physicalAfter: nextPhysical, reservedAfter: balance.reservedQty, valueAfter: nextValue, averageUnitCostAfter: nextAverage,
        originalQuantity: line.originalQuantity, originalUnit: line.originalUnit, conversionFactor: line.conversionFactor,
        inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.inventoryUnit,
        inventoryUnitCost: line.inventoryQuantity.gt(0) ? costOut.div(line.inventoryQuantity).toDecimalPlaces(COST_DP) : ZERO,
        sourceType: 'MeituanDailyPackage', sourceId: record.id, sourceLineId: `${direction}:${line.code}`,
        idempotencyKey, requestFingerprint: fingerprint({ packageDate, line, direction }),
        effectiveAt: lineEffectiveAt(outboundEffectiveAtByCode.get(line.code)),
        note: line.note, sourceName: line.sourceName, createdById: input.userId,
      } })
      await persistBalance(tx, balance, { physicalQty: nextPhysical, reservedQty: balance.reservedQty, inventoryValue: nextValue, averageUnitCost: nextAverage })
      await allocateLotsFefo(tx, { tenantId: input.tenantId, warehouseId: record.warehouseId, productId: line.productId, movementId: movement.id, quantity: line.inventoryQuantity })
      movementIds.push(movement.id)
    }

    const reconciliationItems = record.items.filter(item => item.productId && item.normalizedQuantity !== null).map(item => {
      const balance = balances.get(item.productId!)
      const theoreticalQty = balance?.physicalQty || ZERO
      const snapshotQty = item.normalizedQuantity || ZERO
      const quantityDifference = theoreticalQty.minus(snapshotQty).toDecimalPlaces(QTY_DP)
      const theoreticalValue = balance?.inventoryValue || ZERO
      const valueDifference = theoreticalValue.minus(item.inventoryAmount).toDecimalPlaces(VALUE_DP)
      return {
        productId: item.productId!, externalCode: item.externalCode, externalName: item.externalName,
        inventoryUnit: item.inventoryUnit, theoreticalQty: theoreticalQty.toFixed(QTY_DP), snapshotQty: snapshotQty.toFixed(QTY_DP),
        quantityDifference: quantityDifference.toFixed(QTY_DP), theoreticalValue: theoreticalValue.toFixed(2),
        snapshotValue: item.inventoryAmount.toFixed(2), valueDifference: valueDifference.toFixed(2),
      }
    })
    const different = reconciliationItems.filter(item => new Prisma.Decimal(item.quantityDifference).abs().gt('0.001'))
    const reconciliation = {
      packageDate,
      priorBaselineImportId: baseline.id,
      priorBaselineDate: baselineDate,
      comparedCount: reconciliationItems.length,
      matchedCount: reconciliationItems.length - different.length,
      differenceCount: different.length,
      totalAbsoluteQuantityDifference: different.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.quantityDifference).abs()), ZERO).toFixed(QTY_DP),
      topDifferences: different.sort((a, b) => new Prisma.Decimal(b.quantityDifference).abs().cmp(new Prisma.Decimal(a.quantityDifference).abs())).slice(0, 50),
    }
    const updated = await tx.warehouseInventoryImport.updateMany({
      where: { id: record.id, tenantId: input.tenantId, status: 'STAGED', rowVersion: input.rowVersion },
      data: {
        metadata: {
          ...metadata,
          dailyLedgerApplied: true,
          dailyLedgerAppliedAt: new Date().toISOString(),
          dailyLedgerAppliedById: input.userId,
          dailyLedgerMovementIds: movementIds,
          dailyLedgerReconciliation: reconciliation,
          movementSemantics: 'DAILY_OUTBOUND_LEDGER_AFTER_PRIOR_CLOSING_BASELINE',
          purchasingSemantics: 'DAILY_NET_RECEIPT_LEDGER_AGGREGATED_BY_SKU',
        },
        rowVersion: { increment: 1 },
      },
    })
    if (updated.count !== 1) throw businessError('导入单状态已变化，请刷新后重试', 409)
    await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, role: input.role,
      action: `写入美团 ${packageDate} 供应链当日流水并核对期末库存`, entityType: 'WarehouseInventoryImport',
      target: record.no, targetId: record.id, metadata: {
        baselineDate, inboundCount: positiveInbound.length, outboundCount: outboundLines.length,
        movementCount: movementIds.length, reconciliation,
      },
    } })
    return {
      replayed: false,
      importId: record.id,
      priorBaselineDate: baselineDate,
      inboundCount: positiveInbound.length,
      outboundCount: outboundLines.length,
      movementCount: movementIds.length,
      reconciliation,
    }
  }, 60_000)
}

/**
 * 差异/拒收冲回：把总仓订单出库多记的部分加回仓库账（履约准确性方案 1.1）。
 *
 * 适用：ARRIVAL_SHORTAGE 差异单结案（出库按发货数记、门店实收更少，冲回差额）；
 * 收货整单拒收（货已退回，冲回全部出库）。
 * 不适用：ARRIVAL_DAMAGE——质量差异实物去向未定，冲回会掩盖真实损耗，留给人工/逆向流程。
 *
 * 约束：
 * - 冲回量按原出库流水冻结的 conversionFactor 换算，历史不随主数据改写；
 * - 批次按原 FEFO 消耗（lotAllocation）顺序加回 remainingQty，保持"批次合计=余额"审计不变；
 * - 幂等：reversal:{source}:{sourceId}:{movementId} + 唯一约束，重复结案/重放安全；
 * - 同一原流水累计冲回不得超过原出库量（多条差异单各冲一部分时可叠加）；
 * - reversalOfId 刻意不占用（那是整笔冲销的专属约束），防重靠上述幂等键与累计上限。
 */
export async function reverseDeliveryOutboundInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    userId: string | null
    source: 'LossClaim' | 'ReceiptRejection' | 'ShipCancel'
    sourceId: string
    originalMovementId: string
    quantity: Prisma.Decimal
    reason: string
  },
): Promise<{ reversed: boolean; movementId: string | null; replayed: boolean }> {
  const idempotencyKey = `reversal:${input.source.toLowerCase()}:${input.sourceId}:${input.originalMovementId}`
  const replay = await tx.warehouseLedgerMovement.findFirst({
    where: { tenantId: input.tenantId, idempotencyKey },
    select: { id: true },
  })
  if (replay) return { reversed: false, movementId: replay.id, replayed: true }

  const original = await tx.warehouseLedgerMovement.findFirst({
    where: {
      id: input.originalMovementId,
      tenantId: input.tenantId,
      type: 'ORDER_OUTBOUND',
      sourceType: 'DeliveryOrder',
    },
  })
  if (!original) throw businessError('待冲回的订单出库流水不存在', 404)

  const reverseOriginal = decimal(input.quantity, '冲回数量').toDecimalPlaces(QTY_DP)
  if (reverseOriginal.lte(0)) return { reversed: false, movementId: null, replayed: false }
  if (reverseOriginal.gt(original.originalQuantity)) {
    throw businessError(
      `冲回数量 ${reverseOriginal} 超过原出库数量 ${original.originalQuantity}`,
      409,
    )
  }
  const priorReversals = await tx.warehouseLedgerMovement.aggregate({
    where: {
      tenantId: input.tenantId,
      warehouseId: original.warehouseId,
      productId: original.productId,
      type: 'REVERSAL',
      sourceLineId: original.id,
    },
    _sum: { inventoryQuantity: true },
  })
  const priorReversedQty = new Prisma.Decimal(priorReversals._sum.inventoryQuantity || 0)
  const reverseInventoryQty = reverseOriginal.mul(original.conversionFactor).toDecimalPlaces(QTY_DP)
  if (priorReversedQty.plus(reverseInventoryQty).gt(original.inventoryQuantity)) {
    throw businessError(
      `累计冲回将超过原出库量（已冲 ${priorReversedQty}，本次 ${reverseInventoryQty}，原出库 ${original.inventoryQuantity}）`,
      409,
    )
  }

  const balances = await lockBalances(tx, {
    tenantId: input.tenantId,
    warehouseId: original.warehouseId,
    products: [{ productId: original.productId, inventoryUnit: original.inventoryUnit }],
  })
  const concurrentReplay = await tx.warehouseLedgerMovement.findFirst({
    where: { tenantId: input.tenantId, idempotencyKey },
    select: { id: true },
  })
  if (concurrentReplay) return { reversed: false, movementId: concurrentReplay.id, replayed: true }

  const balance = balances.get(original.productId)!
  const valueIn = reverseInventoryQty.mul(original.inventoryUnitCost).toDecimalPlaces(VALUE_DP)
  const nextPhysical = balance.physicalQty.plus(reverseInventoryQty).toDecimalPlaces(QTY_DP)
  const nextValue = balance.inventoryValue.plus(valueIn).toDecimalPlaces(VALUE_DP)
  const nextAverage = nextAverageCost(nextValue, nextPhysical, balance.averageUnitCost)

  // 批次按原 FEFO 消耗顺序加回，保持批次合计 = 余额（审计 BLOCKER 项）。
  const allocations = await tx.warehouseLedgerLotAllocation.findMany({
    where: { movementId: original.id },
    orderBy: { createdAt: 'asc' },
  })
  let restore = reverseInventoryQty
  for (const allocation of allocations) {
    if (restore.lte(0)) break
    const lot = await tx.warehouseLedgerLot.findUnique({
      where: { id: allocation.lotId },
      select: { initialQty: true, remainingQty: true },
    })
    if (!lot) throw businessError('总仓出库批次不存在，无法安全冲回', 409)
    // A movement can be partially reversed more than once. Restore only the
    // lot's current capacity; otherwise replaying different partial reversals
    // could push remainingQty above initialQty.
    const capacity = Prisma.Decimal.max(ZERO, lot.initialQty.minus(lot.remainingQty)).toDecimalPlaces(QTY_DP)
    const giveBack = Prisma.Decimal.min(restore, allocation.quantity, capacity).toDecimalPlaces(QTY_DP)
    if (giveBack.lte(0)) continue
    await tx.warehouseLedgerLot.update({
      where: { id: allocation.lotId },
      data: { remainingQty: { increment: giveBack }, depletedAt: null },
    })
    restore = restore.minus(giveBack).toDecimalPlaces(QTY_DP)
  }
  if (restore.gt(0)) {
    // 批次不足通常意味着批次被实盘重置等操作清过；余额与流水仍正确，批次差异留给审计解释。
    console.warn(
      `[loss-reversal] 批次恢复不足 movement=${original.id} 缺 ${restore} ${original.inventoryUnit}`,
    )
  }

  const movement = await tx.warehouseLedgerMovement.create({
    data: {
      tenantId: input.tenantId,
      warehouseId: original.warehouseId,
      productId: original.productId,
      type: 'REVERSAL',
      physicalDelta: reverseInventoryQty,
      reservedDelta: ZERO,
      valueDelta: valueIn,
      physicalAfter: nextPhysical,
      reservedAfter: balance.reservedQty,
      valueAfter: nextValue,
      averageUnitCostAfter: nextAverage,
      originalQuantity: reverseOriginal,
      originalUnit: original.originalUnit,
      conversionFactor: original.conversionFactor,
      inventoryQuantity: reverseInventoryQty,
      inventoryUnit: original.inventoryUnit,
      inventoryUnitCost: original.inventoryUnitCost,
      sourceType: input.source === 'LossClaim' ? 'LossClaimReversal' : input.source === 'ShipCancel' ? 'DeliveryOrderShipCancel' : 'ReceiptRejectionReversal',
      sourceId: input.sourceId,
      sourceLineId: original.id,
      idempotencyKey,
      effectiveAt: new Date(),
      note: input.reason.slice(0, 200),
      createdById: input.userId,
    },
  })
  await persistBalance(tx, balance, {
    physicalQty: nextPhysical,
    reservedQty: balance.reservedQty,
    inventoryValue: nextValue,
    averageUnitCost: nextAverage,
  })
  // 比例加价：出库冲回（货退回仓）改变均价后按规则自动重算卖价
  await applyMarkupReprice(tx, {
    tenantId: input.tenantId,
    productId: original.productId,
    averageUnitCost: nextAverage,
    trigger: { type: input.source === 'LossClaim' ? 'LossClaimReversal' : input.source === 'ShipCancel' ? 'DeliveryOrderShipCancel' : 'ReceiptRejectionReversal', id: movement.id },
  })
  return { reversed: true, movementId: movement.id, replayed: false }
}

// ── 单据审核流：金额/成本差额调整（2026-08-24）──────────────────────
// 反审核后改单价/金额时调用：数量不动，只按差额写一条 ADJUSTMENT 流水。
// 入库行（MANUAL_INBOUND）批次未被消耗时同步批次单位成本；
// 出库行（WarehouseManualOutbound）仅调整账面金额（批次已按 FEFO 分摊，不回溯）。
export async function adjustWarehouseMovementValue(input: {
  tenantId: string
  userId: string
  movementId: string
  /** 调整后的行金额（入库=价税合计；出库=成本额），正数 */
  newAmount: Decimalish
  reason: string
  /** 幂等键（调用方按 单据+行+编辑序号 生成，保证同一编辑可安全重试） */
  idempotencyKey: string
  /** 单据上下文，写入调整流水的 sourceType/sourceId */
  docId: string
  docNo: string
}) {
  const warehouseId = await resolveTenantWarehouseId(prisma, input.tenantId, undefined)
  const rawKey = String(input.idempotencyKey || '').trim()
  const idempotencyKey = `doc-value-adjust:${rawKey}`
  if (!rawKey || idempotencyKey.length > 160) throw businessError('调整幂等键无效', 400)
  const newAmount = decimal(input.newAmount, '调整后金额').toDecimalPlaces(VALUE_DP)
  if (newAmount.lte(0)) throw businessError('调整后金额必须大于0', 400)
  const reason = String(input.reason || '').trim()
  if (reason.length < 2 || reason.length > 240) throw businessError('调整原因需为2至240个字符', 400)

  return serializableWithRetry(async tx => {
    const replay = await tx.warehouseLedgerMovement.findUnique({
      where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey } },
    })
    if (replay) return { replayed: true, movement: replay, warehouseId, valueDiff: new Prisma.Decimal(0) }
    const original = await tx.warehouseLedgerMovement.findFirst({
      where: { id: input.movementId, tenantId: input.tenantId, warehouseId },
      include: { createdLot: true, reversal: true, product: { select: { name: true } } },
    })
    if (!original) throw businessError('原流水不存在', 404)
    const isInbound = original.type === 'MANUAL_INBOUND'
    const isManualOutbound = original.type === 'ORDER_OUTBOUND' && original.sourceType === 'WarehouseManualOutbound'
    if (!isInbound && !isManualOutbound) throw businessError('只能调整手工入库/手工出库流水', 409)
    if (original.reversal) throw businessError('该流水已被冲销，不能再调整金额', 409)

    const oldAmount = original.valueDelta.abs().toDecimalPlaces(VALUE_DP)
    const valueDiff = newAmount.minus(oldAmount).toDecimalPlaces(VALUE_DP)
    if (valueDiff.isZero()) return { replayed: false, movement: null, warehouseId, valueDiff }

    const balances = await lockBalances(tx, {
      tenantId: input.tenantId,
      warehouseId,
      products: [{ productId: original.productId, inventoryUnit: original.inventoryUnit }],
    })
    const balance = balances.get(original.productId)!
    // 入库：差额加到账面；出库：成本调高要从账面再扣、调低要补回
    const signedDiff = isInbound ? valueDiff : valueDiff.negated()
    const nextValue = balance.inventoryValue.plus(signedDiff).toDecimalPlaces(VALUE_DP)
    const mode = await warehouseMode(tx, input.tenantId, warehouseId)
    if (mode === 'STRICT' && nextValue.lt(0)) {
      throw businessError(`「${original.product.name}」调整后库存金额将为负，请先核对数量`, 409)
    }
    const normalizedValue = balance.physicalQty.isZero() ? ZERO : nextValue
    const actualValueDelta = normalizedValue.minus(balance.inventoryValue).toDecimalPlaces(VALUE_DP)
    const nextAverage = balance.physicalQty.isZero()
      ? balance.averageUnitCost
      : nextAverageCost(normalizedValue, balance.physicalQty, balance.averageUnitCost)

    const movement = await tx.warehouseLedgerMovement.create({
      data: {
        tenantId: input.tenantId,
        warehouseId,
        productId: original.productId,
        type: 'ADJUSTMENT',
        physicalDelta: ZERO,
        reservedDelta: ZERO,
        valueDelta: actualValueDelta,
        physicalAfter: balance.physicalQty,
        reservedAfter: balance.reservedQty,
        valueAfter: normalizedValue,
        averageUnitCostAfter: nextAverage,
        originalQuantity: new Prisma.Decimal(0),
        originalUnit: original.inventoryUnit,
        conversionFactor: new Prisma.Decimal(1),
        inventoryQuantity: new Prisma.Decimal(0),
        inventoryUnit: original.inventoryUnit,
        inventoryUnitCost: nextAverage,
        sourceType: 'WarehouseDocValueAdjust',
        sourceId: input.docId,
        sourceLineId: original.id,
        idempotencyKey,
        requestFingerprint: fingerprint({ movementId: original.id, newAmount: newAmount.toFixed(VALUE_DP), reason }),
        effectiveAt: new Date(),
        note: `单据 ${input.docNo} 改价：${reason}`.slice(0, 240),
        createdById: input.userId,
        supplierId: original.supplierId,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: balance.physicalQty,
      reservedQty: balance.reservedQty,
      inventoryValue: normalizedValue,
      averageUnitCost: nextAverage,
    })
    // 入库批次完整未被消耗时，同步批次单位成本，使后续 FEFO 出库按新成本走
    if (isInbound && original.createdLot && original.createdLot.remainingQty.equals(original.createdLot.initialQty) && original.physicalDelta.gt(0)) {
      await tx.warehouseLedgerLot.update({
        where: { id: original.createdLot.id },
        data: { inventoryUnitCost: newAmount.div(original.physicalDelta).toDecimalPlaces(COST_DP) },
      })
    }
    // 比例加价：成本变化后按规则自动重算卖价
    await applyMarkupReprice(tx, {
      tenantId: input.tenantId,
      productId: original.productId,
      averageUnitCost: nextAverage,
      trigger: { type: 'WarehouseDocValueAdjust', id: movement.id },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: `单据改价 ${original.product.name}：${oldAmount.toFixed(2)} → ${newAmount.toFixed(2)}（${reason}）`,
        target: input.docNo,
        entityType: 'WarehouseLedgerMovement',
        targetId: movement.id,
        metadata: {
          docId: input.docId,
          docNo: input.docNo,
          originalMovementId: original.id,
          oldAmount: oldAmount.toFixed(VALUE_DP),
          newAmount: newAmount.toFixed(VALUE_DP),
          valueDiff: valueDiff.toFixed(VALUE_DP),
        },
      },
    })
    return { replayed: false, movement, warehouseId, valueDiff }
  })
}
