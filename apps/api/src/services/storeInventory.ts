import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { applyReceiptToCostSlot } from './inventoryCosting'
import { productInventoryUnitCost } from './unitContractGuard'

export type StoreInventorySummary = {
  status: 'AVAILABLE' | 'NO_BASELINE'
  basis: 'PHYSICAL_COUNT' | 'ESTIMATED_FROM_PHYSICAL_COUNT'
  isRealtime: boolean
  asOf: string | null
  openingDate: string | null
  totalValue: number | null
  itemCount: number
  nonzeroCount: number
  zeroCount: number
  matchedCount: number
  unmatchedCount: number
  normalizationPendingCount: number
  lowStockCount: number
  sourceFilename: string | null
}

const emptySummary = (): StoreInventorySummary => ({
  status: 'NO_BASELINE',
  basis: 'PHYSICAL_COUNT',
  isRealtime: false,
  asOf: null,
  openingDate: null,
  totalValue: null,
  itemCount: 0,
  nonzeroCount: 0,
  zeroCount: 0,
  matchedCount: 0,
  unmatchedCount: 0,
  normalizationPendingCount: 0,
  lowStockCount: 0,
  sourceFilename: null,
})

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10)
}

function isMissingSnapshotTable(error: unknown) {
  const e = error as { code?: string; message?: string }
  return e?.code === 'P2021' || Boolean(e?.message?.includes('inventory_snapshots'))
}

/**
 * 最新实物盘点是当前门店库存的可信基准。
 * 在 BOM 消耗和 SKU 映射完整前，只陈述“盘点时点库存”，不伪装成实时库存。
 */
export async function latestStoreInventorySnapshot(tenantId: string, storeId: string, includeItems = false) {
  try {
    const snapshot = await prisma.inventorySnapshot.findFirst({
      where: { tenantId, storeId },
      orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        items: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: {
            product: { select: { id: true, code: true, name: true, unit: true, inventoryUnit: true } },
          },
        },
      },
    })
    if (!snapshot) return { summary: emptySummary(), items: [] }

    const policies = await prisma.storeInventoryPolicy.findMany({
      where: { tenantId, storeId, productId: { in: snapshot.items.flatMap(item => item.productId ? [item.productId] : []) } },
      select: { productId: true, minStock: true, targetStock: true },
    })
    const policyByProduct = new Map(policies.map(policy => [policy.productId, policy]))

    // 门店安全库存按 storeId 隔离；Product.minStock 是供应商库存口径，不能复用。
    const lowStockCount = snapshot.items.filter((item) => {
      if (!item.productId) return false
      const minStock = Number(policyByProduct.get(item.productId)?.minStock || 0)
      const expectedUnit = item.product?.inventoryUnit || item.product?.unit || ''
      const exactWithoutStoredNormalization = item.unit.trim().toLowerCase() === expectedUnit.trim().toLowerCase()
      const quantity = item.normalizedQuantity != null
        ? Number(item.normalizedQuantity)
        : exactWithoutStoredNormalization
          ? Number(item.quantity)
          : null
      if (quantity == null) return false
      return minStock > 0 && quantity > 0 && quantity < minStock
    }).length

    const asOf = dateOnly(snapshot.snapshotDate)
    const opening = new Date(`${asOf}T00:00:00.000Z`)
    opening.setUTCDate(opening.getUTCDate() + 1)
    const summary: StoreInventorySummary = {
      status: 'AVAILABLE',
      basis: 'PHYSICAL_COUNT',
      isRealtime: false,
      asOf,
      openingDate: dateOnly(opening),
      totalValue: Number(snapshot.totalValue),
      itemCount: snapshot.itemCount,
      nonzeroCount: snapshot.nonzeroCount,
      zeroCount: snapshot.zeroCount,
      matchedCount: snapshot.matchedCount,
      unmatchedCount: Math.max(0, snapshot.itemCount - snapshot.matchedCount),
      normalizationPendingCount: snapshot.items.filter(item => item.productId && item.normalizationStatus === 'PENDING').length,
      lowStockCount,
      sourceFilename: snapshot.sourceFilename,
    }
    const items = includeItems
      ? snapshot.items.map((item) => ({
          id: item.id,
          section: item.section,
          name: item.rawName,
          spec: item.rawSpec,
          unit: item.unit,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          amount: Number(item.amount),
          normalizedQuantity: item.normalizedQuantity == null ? null : Number(item.normalizedQuantity),
          normalizedUnit: item.normalizedUnit,
          normalizationStatus: item.normalizationStatus,
          normalizationNote: item.normalizationNote,
          matched: Boolean(item.productId),
          product: item.product
            ? {
                ...item.product,
                minStock: Number(policyByProduct.get(item.product.id)?.minStock || 0),
                targetStock: policyByProduct.get(item.product.id)?.targetStock == null
                  ? null
                  : Number(policyByProduct.get(item.product.id)!.targetStock),
              }
            : null,
        }))
      : []
    return { summary, items }
  } catch (error) {
    // 允许前后端先部署，再执行迁移；界面会诚实显示“盘点基准待导入”。
    if (isMissingSnapshotTable(error)) return { summary: emptySummary(), items: [] }
    throw error
  }
}

type EstimatedSlot = {
  quantity: number
  avgUnitCost: number
  monthIn: number
  monthOut: number
}

type EstimatedEvent = {
  occurredAt: Date
  productId: string
  direction: 'IN' | 'OUT'
  quantity: number
  unitCost?: number
  monthBucket: boolean
}

/**
 * 从最近一次闭店实物盘点向后滚动门店预计库存。
 * 这是账面估算，不冒充实时实物库存；下次盘点会重新建立可信基准。
 */
export async function estimatedStoreInventory(tenantId: string, storeId: string, asOfDate?: string) {
  const asOfDay = asOfDate ? new Date(`${asOfDate}T00:00:00.000Z`) : null
  if (asOfDay && (Number.isNaN(asOfDay.getTime()) || asOfDay.toISOString().slice(0, 10) !== asOfDate)) {
    throw Object.assign(new Error('库存截止日期无效'), { statusCode: 400 })
  }
  const asOfEnd = asOfDate ? new Date(`${asOfDate}T23:59:59.999Z`) : null
  const snapshot = await prisma.inventorySnapshot.findFirst({
    where: { tenantId, storeId, ...(asOfDay ? { snapshotDate: { lte: asOfDay } } : {}) },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: { include: { product: { select: { unit: true, inventoryUnit: true } } } } },
  })
  if (!snapshot) return { summary: emptySummary(), items: [] }

  const snapshotDateText = dateOnly(snapshot.snapshotDate)
  const openingDateText = dayjs(snapshotDateText).add(1, 'day').format('YYYY-MM-DD')
  const openingDate = new Date(`${openingDateText}T00:00:00.000Z`)
  const monthStart = dayjs(asOfDate || undefined).startOf('month').toDate()
  const validReceiptStatuses = ['CONFIRMED', 'ACCOUNTED'] as const
  const [receiptItems, consumptions, manualLossItems, postReceiptLossItems] = await Promise.all([
    prisma.receiptItem.findMany({
      where: {
        receipt: {
          tenantId, storeId,
          status: { in: [...validReceiptStatuses] },
          deliveryDate: { gte: openingDate, ...(asOfDay ? { lte: asOfDay } : {}) },
        },
      },
      select: {
        productId: true, quantity: true, unitPrice: true, expiryDate: true,
        inventoryQuantity: true, inventoryUnitCostSnapshot: true,
        receipt: { select: { deliveryDate: true, createdAt: true } },
      },
    }),
    prisma.stockConsumption.findMany({
      where: { tenantId, storeId, date: { gte: openingDate, ...(asOfDay ? { lte: asOfDay } : {}) }, voidedAt: null },
      select: { productId: true, quantity: true, inventoryQuantity: true, date: true },
    }),
    prisma.lossClaimItem.findMany({
      where: {
        lossClaim: {
          tenantId, storeId, isManual: true,
          status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] },
          createdAt: { gte: openingDate, ...(asOfEnd ? { lte: asOfEnd } : {}) },
        },
      },
      select: { productId: true, lossQty: true, inventoryQuantity: true, lossClaim: { select: { createdAt: true } } },
    }),
    prisma.lossClaimItem.findMany({
      where: {
        lossClaim: {
          tenantId, storeId, isManual: false, payableBasis: 'GROSS_PENDING_CLAIM',
          status: { in: ['PENDING', 'APPROVED', 'AUTO_APPROVED', 'REJECTED', 'NEGOTIATING', 'RESOLVED'] },
          createdAt: { gte: openingDate, ...(asOfEnd ? { lte: asOfEnd } : {}) },
        },
      },
      select: { productId: true, lossQty: true, inventoryQuantity: true, lossClaim: { select: { createdAt: true } } },
    }),
  ])

  const slots = new Map<string, EstimatedSlot>()
  let normalizationPendingCount = 0
  for (const item of snapshot.items) {
    if (!item.productId) continue
    const expectedUnit = item.product?.inventoryUnit || item.product?.unit || ''
    const exactWithoutStoredNormalization = item.unit.trim().toLowerCase() === expectedUnit.trim().toLowerCase()
    const quantity = item.normalizedQuantity != null
      ? Number(item.normalizedQuantity)
      : exactWithoutStoredNormalization
        ? Number(item.quantity)
        : null
    if (quantity == null) {
      normalizationPendingCount += 1
      continue
    }
    const value = Number(item.amount)
    const current = slots.get(item.productId) || { quantity: 0, avgUnitCost: 0, monthIn: 0, monthOut: 0 }
    const currentValue = current.quantity * current.avgUnitCost
    const nextQty = current.quantity + quantity
    current.quantity = nextQty
    current.avgUnitCost = nextQty > 0 ? (currentValue + value) / nextQty : Number(item.unitPrice)
    slots.set(item.productId, current)
  }

  // 已确认收货但单位尚未核验的行是真实业务单据，不应阻塞收货；同时也不能
  // 把“箱/件”等采购数量误当作 g/kg 等库存数量。先从预计库存滚动中排除，
  // 并计入待核验数量，主数据补齐后由补偿任务回填库存快照。
  normalizationPendingCount += receiptItems.filter(item => item.inventoryQuantity == null).length

  const events: EstimatedEvent[] = [
    ...receiptItems.filter(item => item.inventoryQuantity != null).map(item => ({
      // Receipt.deliveryDate 与 BOM 消耗都是 DATE；同日先入库、后按闭店销量扣理论消耗。
      occurredAt: item.receipt.deliveryDate,
      productId: item.productId,
      direction: 'IN' as const,
      quantity: Number(item.inventoryQuantity),
      unitCost: Number(item.inventoryUnitCostSnapshot ?? item.unitPrice),
      monthBucket: item.receipt.deliveryDate >= monthStart,
    })),
    ...consumptions.map(item => ({
      occurredAt: item.date,
      productId: item.productId,
      direction: 'OUT' as const,
      quantity: Number(item.inventoryQuantity ?? item.quantity),
      monthBucket: item.date >= monthStart,
    })),
    ...manualLossItems.map(item => ({
      occurredAt: item.lossClaim.createdAt,
      productId: item.productId,
      direction: 'OUT' as const,
      quantity: Number(item.inventoryQuantity ?? item.lossQty),
      monthBucket: item.lossClaim.createdAt >= monthStart,
    })),
    ...postReceiptLossItems.map(item => ({
      occurredAt: item.lossClaim.createdAt,
      productId: item.productId,
      direction: 'OUT' as const,
      quantity: Number(item.inventoryQuantity ?? item.lossQty),
      monthBucket: item.lossClaim.createdAt >= monthStart,
    })),
  ].sort((a, b) => {
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime()
    if (byTime !== 0) return byTime
    if (a.direction === b.direction) return 0
    return a.direction === 'IN' ? -1 : 1
  })

  for (const event of events) {
    const current = slots.get(event.productId) || { quantity: 0, avgUnitCost: 0, monthIn: 0, monthOut: 0 }
    if (event.direction === 'IN') {
      const incomingCost = Number(event.unitCost || 0)
      const next = applyReceiptToCostSlot({ quantity: current.quantity, averageCost: current.avgUnitCost }, event.quantity, incomingCost)
      current.quantity = next.quantity
      current.avgUnitCost = next.averageCost
      if (event.monthBucket) current.monthIn += event.quantity
    } else {
      current.quantity -= event.quantity
      if (event.monthBucket) current.monthOut += event.quantity
    }
    slots.set(event.productId, current)
  }

  const productIds = [...slots.keys()]
  const [products, policies] = productIds.length > 0
    ? await Promise.all([
        prisma.product.findMany({
          where: { tenantId, id: { in: productIds } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        prisma.storeInventoryPolicy.findMany({
          where: { tenantId, storeId, productId: { in: productIds } },
          select: { productId: true, minStock: true, targetStock: true },
        }),
      ])
    : [[], []]
  const policyByProduct = new Map(policies.map(policy => [policy.productId, policy]))
  const nearestExpiry = new Map<string, Date>()
  for (const item of receiptItems
    .filter(item => item.expiryDate)
    .sort((a, b) => a.expiryDate!.getTime() - b.expiryDate!.getTime())) {
    if (!nearestExpiry.has(item.productId)) nearestExpiry.set(item.productId, item.expiryDate!)
  }

  const today = dayjs(asOfDate || undefined).startOf('day')
  const rows = products.map(product => {
    const slot = slots.get(product.id)!
    const expiry = nearestExpiry.get(product.id) || null
    const daysToExpiry = expiry ? dayjs(expiry).startOf('day').diff(today, 'day') : null
    const stock = slot.quantity
    // price 的单位含义由 costUnit 决定，分母只能是 inventoryUnitsPerCostUnit。
    const avgUnitCost = slot.avgUnitCost || productInventoryUnitCost(product) || 0
    const policy = policyByProduct.get(product.id)
    const minStock = Number(policy?.minStock || 0)
    return {
      ...product,
      purchaseUnit: product.unit,
      unit: product.inventoryUnit || product.unit,
      minStock,
      targetStock: policy?.targetStock == null ? null : Number(policy.targetStock),
      stock,
      avgUnitCost,
      inventoryValue: Math.max(0, stock) * avgUnitCost,
      monthIn: slot.monthIn,
      monthOut: slot.monthOut,
      nearestExpiry: expiry ? expiry.toISOString().slice(0, 10) : null,
      daysToExpiry,
      isExpired: daysToExpiry != null && daysToExpiry < 0,
      isExpiringSoon: daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry <= 7,
      isLowStock: minStock > 0 && stock < minStock,
      hasDataIssue: stock < -0.0001,
      inventoryBasis: 'ESTIMATED_FROM_PHYSICAL_COUNT' as const,
      openingDate: openingDateText,
      asOf: asOfEnd?.toISOString() || new Date().toISOString(),
      baselineItemCount: snapshot.itemCount,
      baselineMatchedCount: snapshot.matchedCount,
      estimateIncomplete: snapshot.matchedCount < snapshot.itemCount,
    }
  })

  return {
    summary: {
      status: 'AVAILABLE' as const,
      basis: 'ESTIMATED_FROM_PHYSICAL_COUNT' as const,
      isRealtime: true as const,
      asOf: asOfEnd?.toISOString() || new Date().toISOString(),
      openingDate: openingDateText,
      totalValue: rows.reduce((sum, row) => sum + row.inventoryValue, 0),
      itemCount: rows.length,
      nonzeroCount: rows.filter(row => row.stock > 0).length,
      zeroCount: rows.filter(row => Math.abs(row.stock) < 0.0001).length,
      matchedCount: snapshot.matchedCount,
      unmatchedCount: Math.max(0, snapshot.itemCount - snapshot.matchedCount),
      normalizationPendingCount,
      lowStockCount: rows.filter(row => row.isLowStock).length,
      sourceFilename: snapshot.sourceFilename,
    },
    items: rows,
  }
}
