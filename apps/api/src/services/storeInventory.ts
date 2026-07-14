import { prisma } from '@dianjie/db'

export type StoreInventorySummary = {
  status: 'AVAILABLE' | 'NO_BASELINE'
  basis: 'PHYSICAL_COUNT'
  isRealtime: false
  asOf: string | null
  openingDate: string | null
  totalValue: number | null
  itemCount: number
  nonzeroCount: number
  zeroCount: number
  matchedCount: number
  unmatchedCount: number
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
          orderBy: { sortOrder: 'asc' },
          include: {
            product: { select: { id: true, code: true, name: true, unit: true, minStock: true } },
          },
        },
      },
    })
    if (!snapshot) return { summary: emptySummary(), items: [] }

    // 低库存只对已经唯一匹配到采购 SKU、且配置了安全库存的品项计算。
    const lowStockCount = snapshot.items.filter((item) => {
      const minStock = Number(item.product?.minStock || 0)
      const quantity = Number(item.quantity)
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
          matched: Boolean(item.productId),
          product: item.product
            ? { ...item.product, minStock: Number(item.product.minStock) }
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
