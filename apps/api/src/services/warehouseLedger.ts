import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { resolveProductFourUnits, type ProductInventoryUnitLike } from './inventoryUnits'
import { resolveTenantWarehouseId } from './defaultWarehouse'
import { physicalUnitFactor, sourceSpecMassFactor, sourceSpecPackageFactor } from './warehouseInventoryImport'

const ZERO = new Prisma.Decimal(0)
const QTY_DP = 6
const VALUE_DP = 4
const COST_DP = 6

type Decimalish = Prisma.Decimal | string | number

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
  const originalQuantity = quantity(line.quantity, `${line.productName || '商品'}订货数量`)
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
    batchNo?: string | null
    manufactureDate?: Date | null
    expiryDate?: Date | null
  }>
  effectiveAt: Date
  idempotencyKey: string
  sourceName?: string | null
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
        createdById: input.userId,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: nextPhysical,
      reservedQty: balance.reservedQty,
      inventoryValue: nextValue,
      averageUnitCost: nextAverage,
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
    const unitPrice = decimal(item.unitPrice, `${product.name}采购单价`).toDecimalPlaces(VALUE_DP)
    if (unitPrice.lte(0)) throw businessError(`${product.name}采购单价必须大于0`, 400)
    const totalAmount = purchaseQuantity.mul(unitPrice).toDecimalPlaces(VALUE_DP)
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
          createdById: input.userId,
        },
      })
      await persistBalance(tx, balance, {
        physicalQty: nextPhysical,
        reservedQty: balance.reservedQty,
        inventoryValue: nextValue,
        averageUnitCost: nextAverage,
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
        reversalOfId: original.id,
      },
    })
    await persistBalance(tx, balance, {
      physicalQty: nextPhysical,
      reservedQty: balance.reservedQty,
      inventoryValue: normalizedValue,
      averageUnitCost: nextAverage,
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
  const orderScope = await tx.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, tenantId: input.tenantId },
    select: { status: true, supplier: { select: { sourceType: true } } },
  })
  if (!orderScope || orderScope.supplier.sourceType !== 'HEADQ_WAREHOUSE') return
  // A SHADOW task may start after a fast cancel or shipment. Current business
  // state wins over the stale ACCEPTED event so a late projector can never
  // recreate an ACTIVE reservation on a closed order.
  if (orderScope.status !== 'CONFIRMED') return
  const warehouseId = await resolveTenantWarehouseId(tx, input.tenantId, undefined)
  const mode = await warehouseMode(tx, input.tenantId, warehouseId)
  const lines = input.lines.map(resolveFrozenOrderInventoryLine)
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
async function assertSingleOutboundLedgerSource(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; warehouseId: string; incoming: 'DeliveryOrder' | 'MeituanDailyPackage' },
) {
  const conflicting = input.incoming === 'DeliveryOrder' ? 'MeituanDailyPackage' : 'DeliveryOrder'
  const existing = await tx.warehouseLedgerMovement.findFirst({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, sourceType: conflicting },
    select: { id: true, effectiveAt: true },
  })
  if (!existing) return
  const label = {
    DeliveryOrder: '系统订货发货链路',
    MeituanDailyPackage: '美团每日数据包',
  }
  throw businessError(
    `该总仓的出库账已由「${label[conflicting]}」记录（最近一笔 ${existing.effectiveAt.toISOString().slice(0, 10)}），`
    + `不能同时用「${label[input.incoming]}」再记一次——同一批货会被扣减两次。`
    + '要切换记账来源，请先冲销另一条路径已写入的流水。',
    409,
  )
}

export async function consumeWarehouseLedgerForShipment(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    purchaseOrderId: string
    deliveryOrderId: string
    orderNo: string
    userId: string
    effectiveAt?: Date
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
  const warehouseId = await resolveTenantWarehouseId(tx, input.tenantId, undefined)
  await assertSingleOutboundLedgerSource(tx, { tenantId: input.tenantId, warehouseId, incoming: 'DeliveryOrder' })
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
    const idempotencyKey = `delivery-outbound:${input.deliveryOrderId}:${line.purchaseOrderItemId}`
    const existingMovement = await tx.warehouseLedgerMovement.findUnique({
      where: { tenantId_warehouseId_idempotencyKey: { tenantId: input.tenantId, warehouseId, idempotencyKey } },
    })
    if (existingMovement) continue
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
      const partiallyReleased = line.shippedInventoryQuantity.lt(reservation.inventoryQuantity)
      await tx.warehouseLedgerReservation.update({
        where: { id: reservation.id },
        data: {
          status: line.shippedInventoryQuantity.gt(0) ? 'CONSUMED' : 'RELEASED',
          fulfilledInventoryQty: line.shippedInventoryQuantity,
          consumedAt: line.shippedInventoryQuantity.gt(0) ? effectiveAt : null,
          releasedAt: partiallyReleased || line.shippedInventoryQuantity.isZero() ? effectiveAt : null,
        },
      })
    }
  }
}

export async function postWarehouseShipment(input: {
  tenantId: string
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
      note: string
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
        note: `美团 ${packageDate} 配送出库${Array.isArray(line.documents) ? `（${line.documents.length} 单）` : ''}`,
      }
    }

    const resolvedInbound = inboundSource
      .map(source => ({ source, line: resolveInbound(source) }))
      .filter((item): item is { source: DailyPackageInboundLine; line: ResolvedLine } => Boolean(item.line))
    const purchaseReturns = resolvedInbound.filter(item => Number(item.source.quantity) < 0).map(item => item.line)
    const positiveInbound = resolvedInbound.filter(item => Number(item.source.quantity) > 0).map(item => item.line)
    const outboundLines = [...outboundSource.map(resolveOutbound).filter((line): line is ResolvedLine => Boolean(line)), ...purchaseReturns]
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
    })
    const mode = await warehouseMode(tx, input.tenantId, record.warehouseId)
    const effectiveAt = new Date(`${packageDate}T23:59:00+08:00`)
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
        note: line.note, sourceName: line.sourceName, createdById: input.userId,
      } })
      await persistBalance(tx, balance, { physicalQty: nextPhysical, reservedQty: balance.reservedQty, inventoryValue: nextValue, averageUnitCost: nextAverage })
      await tx.warehouseLedgerLot.create({ data: {
        tenantId: input.tenantId, warehouseId: record.warehouseId, productId: line.productId, kind: 'MANUAL_INBOUND',
        batchNo: `DP-${packageDate.replaceAll('-', '')}-${record.id.slice(-6)}-${line.productId.slice(-6)}`,
        initialQty: line.inventoryQuantity, remainingQty: line.inventoryQuantity, inventoryUnit: line.inventoryUnit,
        inventoryUnitCost: unitCost, sourceName: line.sourceName, sourceMovementId: movement.id,
      } })
      movementIds.push(movement.id)
    }

    for (const line of outboundLines) {
      const direction = purchaseReturns.includes(line) ? 'RETURN' : 'OUT'
      const idempotencyKey = `daily-package:${record.id}:${direction.toLowerCase()}:${line.productId}`
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
        idempotencyKey, requestFingerprint: fingerprint({ packageDate, line, direction }), effectiveAt,
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
