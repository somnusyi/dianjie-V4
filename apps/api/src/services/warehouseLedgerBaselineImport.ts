import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { resolveProductFourUnits, type ProductInventoryUnitLike } from './inventoryUnits'
import { applyMarkupReprice } from './markupPricing'

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

export type WarehouseBaselineItemInput = {
  importItemId: string
  productId: string
  countedInventoryQuantity: Decimalish
  countedInventoryValue: Decimalish
  sourceExternalCode?: string
  sourceExternalName?: string
}

export type WarehouseBaselineBlockingIssue = {
  code: string
  message: string
  detail?: string
}

export type WarehouseBaselineImportResult = {
  blocked: boolean
  importId: string
  importNo: string
  warehouseId: string
  snapshotAt: string
  items: Array<{
    productId: string
    movementId: string | null
    lotId: string | null
    physicalDelta: string
    valueDelta: string
    physicalAfter: string
    valueAfter: string
    movementType: 'OPENING_BALANCE' | 'ADJUSTMENT'
  }>
  blockingIssues: WarehouseBaselineBlockingIssue[]
  createdCount: number
  adjustedCount: number
}

function json<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value))
}

function metadataObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function shanghaiDateText(value: Date) {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function warehouseSnapshotCutoffShanghai(snapshotDate: Date) {
  const date = snapshotDate.toISOString().slice(0, 10)
  const nextDate = new Date(`${date}T00:00:00.000Z`)
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  return new Date(new Date(`${nextDate.toISOString().slice(0, 10)}T00:00:00.000+08:00`).getTime() - 1)
}

export function warehouseSnapshotEffectiveAt(
  snapshotDate: Date,
  metadata: Record<string, unknown>,
) {
  const sourceSnapshotAt = metadata.sourceSnapshotAt
  if (sourceSnapshotAt == null) return warehouseSnapshotCutoffShanghai(snapshotDate)
  if (typeof sourceSnapshotAt !== 'string') {
    throw Object.assign(new Error('库存快照时间格式无效'), { statusCode: 400 })
  }
  const parsed = new Date(sourceSnapshotAt)
  if (Number.isNaN(parsed.getTime())) {
    throw Object.assign(new Error('库存快照时间格式无效'), { statusCode: 400 })
  }
  const snapshotDateText = snapshotDate.toISOString().slice(0, 10)
  if (shanghaiDateText(parsed) !== snapshotDateText) {
    throw Object.assign(new Error('库存快照时间与快照日期不一致'), { statusCode: 400 })
  }
  return parsed
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decimal(value: Decimalish, field: string) {
  try {
    const result = new Prisma.Decimal(value)
    if (result.isFinite()) return result
  } catch {
    // Normalized below.
  }
  throw Object.assign(new Error(`${field}无效`), { statusCode: 400 })
}

function nonnegativeQuantity(value: Decimalish, field: string) {
  const result = decimal(value, field).toDecimalPlaces(QTY_DP)
  if (result.lt(0)) throw Object.assign(new Error(`${field}不能小于0`), { statusCode: 400 })
  return result
}

async function serializableWithRetry<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 60_000,
      })
    } catch (error: any) {
      if (!['P2034', 'P2002'].includes(error?.code) || attempt === 4) throw error
    }
  }
  throw new Error('总仓期初基线事务重试失败')
}

async function lockBalances(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; warehouseId: string; products: Array<{ productId: string; inventoryUnit: string }> },
) {
  const byProduct = new Map<string, string>()
  for (const item of input.products) {
    const existing = byProduct.get(item.productId)
    if (existing && existing !== item.inventoryUnit) {
      throw Object.assign(new Error('同一商品在同一事务中出现不同库存单位'), { statusCode: 400 })
    }
    byProduct.set(item.productId, item.inventoryUnit)
  }
  const productIds = [...byProduct.keys()].sort()
  for (const productId of productIds) {
    await tx.warehouseLedgerBalance.upsert({
      where: {
        tenantId_warehouseId_productId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId },
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
  if (rows.length !== productIds.length) {
    throw Object.assign(new Error('库存余额初始化失败，请重试'), { statusCode: 409 })
  }
  for (const row of rows) {
    const expectedUnit = byProduct.get(row.productId)!
    if (row.inventoryUnit !== expectedUnit) {
      const canChange = row.physicalQty.isZero() && row.reservedQty.isZero() && row.inventoryValue.isZero()
      if (!canChange) {
        throw Object.assign(
          new Error(`商品库存单位已从 ${row.inventoryUnit} 变为 ${expectedUnit}，请先执行单位迁移`),
          { statusCode: 409 },
        )
      }
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

async function writeOneBaseline(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId: string
    userId: string
    importId: string
    snapshotAt: Date
    allowZeroValue: boolean
    item: WarehouseBaselineItemInput
  },
) {
  const product = await tx.product.findFirst({
    where: { id: input.item.productId, tenantId: input.tenantId },
    select: {
      id: true, name: true, unit: true, purchaseUnit: true, inventoryUnit: true,
      orderUnit: true, costUnit: true,
      inventoryUnitsPerPurchaseUnit: true, inventoryUnitsPerOrderUnit: true,
      inventoryUnitsPerCostUnit: true, unitConversionStatus: true,
    },
  })
  if (!product) throw Object.assign(new Error('商品不存在'), { statusCode: 404 })
  const contract = resolveProductFourUnits(product as ProductInventoryUnitLike)

  const countedQuantity = nonnegativeQuantity(input.item.countedInventoryQuantity, '基线库存数量')
  const countedValue = decimal(input.item.countedInventoryValue, '基线库存金额').toDecimalPlaces(VALUE_DP)
  if (countedValue.lt(0)) throw Object.assign(new Error('基线库存金额不能小于0'), { statusCode: 400 })
  if (countedQuantity.isZero() && !countedValue.isZero()) {
    throw Object.assign(new Error('基线数量为0时金额必须为0'), { statusCode: 400 })
  }
  if (countedQuantity.gt(0) && countedValue.lte(0) && !input.allowZeroValue) {
    throw Object.assign(new Error('有基线库存时金额必须大于0'), { statusCode: 400 })
  }

  const previousCount = await tx.warehouseLedgerMovement.findFirst({
    where: {
      tenantId: input.tenantId, warehouseId: input.warehouseId,
      productId: product.id, type: { in: ['OPENING_BALANCE', 'ADJUSTMENT'] },
    },
    select: { id: true },
  })
  const movementType = previousCount ? 'ADJUSTMENT' as const : 'OPENING_BALANCE' as const

  const balances = await lockBalances(tx, {
    tenantId: input.tenantId, warehouseId: input.warehouseId,
    products: [{ productId: product.id, inventoryUnit: contract.inventoryUnit }],
  })
  const balance = balances.get(product.id)!

  const beforePhysical = new Prisma.Decimal(balance.physicalQty)
  const beforeValue = new Prisma.Decimal(balance.inventoryValue)

  const physicalDelta = countedQuantity.minus(beforePhysical).toDecimalPlaces(QTY_DP)
  const valueDelta = countedValue.minus(beforeValue).toDecimalPlaces(VALUE_DP)
  const averageUnitCost = countedQuantity.gt(0)
    ? countedValue.div(countedQuantity).toDecimalPlaces(COST_DP)
    : ZERO

  const idempotencyKey = `baseline-snapshot:${input.importId}:${product.id}`
  const requestFingerprint = fingerprint({
    productId: product.id,
    countedQuantity: countedQuantity.toFixed(QTY_DP),
    countedValue: countedValue.toFixed(VALUE_DP),
    effectiveAt: input.snapshotAt.toISOString(),
    importId: input.importId,
  })

  const movement = await tx.warehouseLedgerMovement.create({
    data: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      productId: product.id,
      type: movementType,
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
      sourceType: 'WarehouseBaselineSnapshot',
      sourceId: input.importId,
      sourceLineId: input.item.importItemId,
      idempotencyKey,
      requestFingerprint,
      effectiveAt: input.snapshotAt,
      note: previousCount
        ? '供应链总仓库存基线校准'
        : `供应链总仓库存基线期初建账 snapshot=${input.snapshotAt.toISOString().slice(0, 10)}${input.allowZeroValue && countedValue.isZero() ? ' cost=pending' : ''}`,
      sourceName: '供应链总仓库存基线快照',
      createdById: input.userId,
    },
  })

  await persistBalance(tx, balance, {
    physicalQty: countedQuantity,
    reservedQty: balance.reservedQty,
    inventoryValue: countedValue,
    averageUnitCost,
  })

  // 比例加价：基线快照确立均价后按规则自动重算卖价
  await applyMarkupReprice(tx, {
    tenantId: input.tenantId,
    productId: product.id,
    averageUnitCost,
    trigger: { type: 'WarehouseBaselineSnapshot', id: movement.id },
  })

  await tx.warehouseInventoryImportItem.update({
    where: { id: input.item.importItemId },
    data: {
      oldQuantity: beforePhysical,
      delta: physicalDelta,
      movementId: movement.id,
    },
  })

  const oldLots = await tx.warehouseLedgerLot.findMany({
    where: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id, remainingQty: { gt: 0 } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const lot of oldLots) {
    await tx.warehouseLedgerLot.update({
      where: { id: lot.id },
      data: { remainingQty: ZERO, depletedAt: input.snapshotAt },
    })
    await tx.warehouseLedgerLotAllocation.create({
      data: {
        tenantId: input.tenantId, warehouseId: input.warehouseId, productId: product.id,
        lotId: lot.id, movementId: movement.id,
        quantity: lot.remainingQty,
        unitCost: lot.inventoryUnitCost,
        value: lot.remainingQty.mul(lot.inventoryUnitCost).toDecimalPlaces(VALUE_DP),
      },
    })
  }

  let lot = null
  if (countedQuantity.gt(0)) {
    const prefix = previousCount ? 'BLA' : 'BL'
    lot = await tx.warehouseLedgerLot.create({
      data: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        productId: product.id,
        kind: previousCount ? 'ADJUSTMENT' : 'OPENING',
        batchNo: `${prefix}-${input.snapshotAt.toISOString().slice(0, 10).replaceAll('-', '')}-${movement.id.slice(-8)}`,
        initialQty: countedQuantity,
        remainingQty: countedQuantity,
        inventoryUnit: contract.inventoryUnit,
        inventoryUnitCost: averageUnitCost,
        sourceName: '供应链总仓库存基线快照',
        sourceMovementId: movement.id,
      },
    })
  }

  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: `${previousCount ? '总仓库存基线校准' : '总仓库存基线建账'} ${product.name} ${countedQuantity.toFixed()} ${contract.inventoryUnit}`,
      target: movement.id,
      entityType: 'WarehouseLedgerMovement',
      targetId: movement.id,
      metadata: {
        warehouseId: input.warehouseId,
        productId: product.id,
        importId: input.importId,
        snapshotAt: input.snapshotAt.toISOString(),
        beforeQuantity: beforePhysical.toFixed(QTY_DP),
        beforeValue: beforeValue.toFixed(VALUE_DP),
        countedQuantity: countedQuantity.toFixed(QTY_DP),
        physicalDelta: physicalDelta.toFixed(QTY_DP),
        countedValue: countedValue.toFixed(VALUE_DP),
        costPending: input.allowZeroValue && countedQuantity.gt(0) && countedValue.isZero(),
        inventoryUnit: contract.inventoryUnit,
        movementType,
        externalCode: input.item.sourceExternalCode || null,
        externalName: input.item.sourceExternalName || null,
      },
    },
  })

  return { movementId: movement.id, lotId: lot?.id ?? null, movementType }
}

/**
 * Apply a historical inventory snapshot as a dated baseline to the warehouse
 * ledger. Unlike the legacy Product.stock confirm flow (permanently 410), this
 * writes to the independent warehouse_ledger_balances with full audit trail.
 *
 * Safety guarantees:
 * - Refuses when any non-zero item is unmatched or has blocking issues.
 * - Refuses when warehouse_ledger_movements exist after snapshotAt (proves
 *   incomplete post-snapshot facts).
 * - Idempotent via per-product idempotency keys.
 * - Uses serializable isolation with retry for balance consistency.
 * - Never changes warehouse inventoryMode (does NOT auto-switch to STRICT).
 */
export async function recordWarehouseBaselineSnapshot(input: {
  tenantId: string
  userId: string
  role: string
  importId: string
  rowVersion: number
}): Promise<WarehouseBaselineImportResult> {
  return serializableWithRetry(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`warehouse-baseline-import:${input.tenantId}:${input.importId}`}))`)

    const record = await tx.warehouseInventoryImport.findFirst({
      where: { id: input.importId, tenantId: input.tenantId },
      include: { items: { orderBy: { rowNumber: 'asc' } } },
    })
    if (!record) throw Object.assign(new Error('库存导入单不存在'), { statusCode: 404 })
    if (record.status !== 'STAGED' || record.rowVersion !== input.rowVersion) {
      throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
    }
    const metadata = metadataObject(record.metadata)
    const allowZeroValue = metadata.costSemantics === 'UNAVAILABLE'
      || metadata.costSemantics === 'SOURCE_INVENTORY_AMOUNT_PARTIAL'
    if (metadata.baselineApplied === true) {
      throw Object.assign(new Error('该导入单已应用过基线，不能重复'), { statusCode: 409 })
    }
    const snapshotDate = record.snapshotDate.toISOString().slice(0, 10)
    const shanghaiToday = shanghaiDateText(new Date())
    if (snapshotDate > shanghaiToday) {
      throw Object.assign(new Error('库存快照日期不能晚于今天'), { statusCode: 400 })
    }
    const snapshotAt = warehouseSnapshotEffectiveAt(record.snapshotDate, metadata)
    if (snapshotAt.getTime() > Date.now()) {
      throw Object.assign(new Error('库存快照时间不能晚于当前时间'), { statusCode: 400 })
    }
    const warehouse = await tx.warehouse.findFirst({
      where: { id: record.warehouseId, tenantId: input.tenantId, isActive: true },
      select: { id: true },
    })
    if (!warehouse) throw Object.assign(new Error('总仓不存在或已停用'), { statusCode: 404 })

    const blockingIssues: WarehouseBaselineBlockingIssue[] = []
    const items: WarehouseBaselineItemInput[] = []
    const seenProductIds = new Set<string>()
    for (const item of record.items) {
      const countedQuantity = decimal(item.normalizedQuantity ?? item.sourceQuantity, '基线库存数量')
      const itemIssues = Array.isArray(item.issues)
        ? item.issues.filter(issue => issue && typeof issue === 'object') as Array<Record<string, unknown>>
        : []
      if (!item.productId) {
        // Zero unmatched rows remain on the immutable import detail for audit,
        // but are not warehouse facts and therefore must not create ledger rows.
        if (countedQuantity.gt(0)) {
          blockingIssues.push({
            code: 'SKU_UNMATCHED',
            message: `${item.externalName || item.externalCode || '商品'} 未匹配系统商品`,
          })
        }
        continue
      }
      if (countedQuantity.gt(0) && itemIssues.length > 0) {
        for (const issue of itemIssues) {
          blockingIssues.push({
            code: String(issue.code || 'IMPORT_ITEM_BLOCKED'),
            message: String(issue.message || `${item.externalName || item.externalCode} 存在未解决的导入问题`),
            detail: issue.detail == null ? undefined : String(issue.detail),
          })
        }
        continue
      }
      if (seenProductIds.has(item.productId)) {
        blockingIssues.push({
          code: 'DUPLICATE_PRODUCT_MAPPING',
          message: `${item.externalName || item.externalCode} 与其他行映射到同一系统商品`,
        })
        continue
      }
      seenProductIds.add(item.productId)
      // Mapped zero rows are deliberately included: a snapshot quantity of
      // zero is an absolute fact that clears stale balances and positive lots.
      items.push({
        importItemId: item.id,
        productId: item.productId,
        countedInventoryQuantity: countedQuantity,
        countedInventoryValue: item.inventoryAmount,
        sourceExternalCode: item.externalCode,
        sourceExternalName: item.externalName,
      })
    }
    if (blockingIssues.length > 0) {
      return {
        blocked: true,
        importId: record.id,
        importNo: record.no,
        warehouseId: record.warehouseId,
        snapshotAt: snapshotAt.toISOString(),
        items: [],
        blockingIssues,
        createdCount: 0,
        adjustedCount: 0,
      }
    }
    if (items.length === 0) {
      throw Object.assign(new Error('没有可建账的已映射商品，请先完成商品映射'), { statusCode: 409 })
    }

    items.sort((a, b) => a.productId.localeCompare(b.productId))
    const productIds = items.map(item => item.productId)

    const laterMovement = await tx.warehouseLedgerMovement.findFirst({
      where: {
        tenantId: input.tenantId,
        warehouseId: record.warehouseId,
        productId: { in: productIds },
        effectiveAt: { gt: snapshotAt },
      },
      include: { product: { select: { name: true } } },
      orderBy: { effectiveAt: 'asc' },
    })
    if (laterMovement) {
      throw Object.assign(
        new Error(`${laterMovement.product.name} 在快照日后已有总仓流水（${laterMovement.type}），不能安全写入基线；请补齐 ${snapshotDate} 后的连续出入库事实`),
        { statusCode: 409 },
      )
    }

    const writtenItems: WarehouseBaselineImportResult['items'] = []
    let createdCount = 0
    let adjustedCount = 0

    for (const item of items) {
      const { movementId, lotId, movementType } = await writeOneBaseline(tx, {
        tenantId: input.tenantId,
        warehouseId: record.warehouseId,
        userId: input.userId,
        importId: input.importId,
        snapshotAt,
        allowZeroValue,
        item,
      })
      const movement = await tx.warehouseLedgerMovement.findUnique({ where: { id: movementId } })
      writtenItems.push({
        productId: item.productId,
        movementId,
        lotId,
        physicalDelta: movement!.physicalDelta.toFixed(),
        valueDelta: movement!.valueDelta.toFixed(),
        physicalAfter: movement!.physicalAfter.toFixed(),
        valueAfter: movement!.valueAfter.toFixed(),
        movementType,
      })
      if (movementType === 'OPENING_BALANCE') createdCount += 1
      else adjustedCount += 1
    }

    const appliedAt = new Date()
    const updated = await tx.warehouseInventoryImport.updateMany({
      where: {
        id: record.id,
        tenantId: input.tenantId,
        status: 'STAGED',
        rowVersion: input.rowVersion,
      },
      data: {
        status: 'CONFIRMED',
        confirmedById: input.userId,
        confirmedAt: appliedAt,
        metadata: json({
          ...metadata,
          baselineApplied: true,
          baselineAppliedAt: appliedAt.toISOString(),
          baselineAppliedById: input.userId,
          baselineSnapshotAt: snapshotAt.toISOString(),
          baselineCreatedCount: createdCount,
          baselineAdjustedCount: adjustedCount,
        }),
        rowVersion: { increment: 1 },
      },
    })
    if (updated.count !== 1) {
      throw Object.assign(new Error('导入单状态已变化，请刷新后重试'), { statusCode: 409 })
    }

    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role as any,
        action: `应用供应链库存基线 ${record.no} snapshot=${snapshotDate}`,
        entityType: 'WarehouseInventoryImport',
        target: record.no,
        targetId: record.id,
        metadata: json({
          importId: record.id,
          snapshotAt: snapshotAt.toISOString(),
          itemCount: writtenItems.length,
          createdCount,
          adjustedCount,
          fileHash: record.fileHash,
        }),
      },
    })

    return {
      blocked: false,
      importId: record.id,
      importNo: record.no,
      warehouseId: record.warehouseId,
      snapshotAt: snapshotAt.toISOString(),
      items: writtenItems,
      blockingIssues: [],
      createdCount,
      adjustedCount,
    }
  })
}
