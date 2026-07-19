export type BomItemLike = {
  productId: string
  quantity: unknown
  lossRate: unknown
}

export type BomVersionLike<TItem extends BomItemLike = BomItemLike> = {
  id: string
  variantKey: string
  versionNo: number
  status: string
  effectiveFrom: Date | string | null
  effectiveTo: Date | string | null
  items: TItem[]
}

function calendarDate(value: Date | string | null | undefined) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

export function isBomVersionEffective(version: BomVersionLike, businessDate: Date | string) {
  if (version.status !== 'PUBLISHED') return false
  const target = calendarDate(businessDate)
  const from = calendarDate(version.effectiveFrom)
  const to = calendarDate(version.effectiveTo)
  if (!target || !from) return false
  return from <= target && (!to || target <= to)
}

/**
 * 先按 POS 规格精确匹配；找不到时再回退默认 BOM。每个规格在同一天只允许一个已发布版本。
 */
export function selectEffectiveBomVersion<T extends BomVersionLike>(
  versions: T[],
  businessDate: Date | string,
  variantKey: string,
): T | null {
  const candidates = versions
    .filter(version => isBomVersionEffective(version, businessDate))
    .sort((left, right) => {
      const byDate = String(calendarDate(right.effectiveFrom)).localeCompare(String(calendarDate(left.effectiveFrom)))
      return byDate || right.versionNo - left.versionNo
    })
  return candidates.find(version => version.variantKey === variantKey)
    || candidates.find(version => version.variantKey === '')
    || null
}

export function bomDateRangesOverlap(
  left: { effectiveFrom: Date | string; effectiveTo?: Date | string | null },
  right: { effectiveFrom: Date | string; effectiveTo?: Date | string | null },
) {
  const leftFrom = calendarDate(left.effectiveFrom)!
  const leftTo = calendarDate(left.effectiveTo) || '9999-12-31'
  const rightFrom = calendarDate(right.effectiveFrom)!
  const rightTo = calendarDate(right.effectiveTo) || '9999-12-31'
  return leftFrom <= rightTo && rightFrom <= leftTo
}

export function calculateBomConsumptions(saleQuantity: number, items: BomItemLike[]) {
  const byProduct = new Map<string, number>()
  for (const item of items) {
    const quantity = saleQuantity * Number(item.quantity) * (1 + Number(item.lossRate))
    if (quantity <= 0) continue
    byProduct.set(item.productId, (byProduct.get(item.productId) || 0) + quantity)
  }
  return [...byProduct.entries()]
    .map(([productId, quantity]) => ({
      productId,
      quantity: Math.round((quantity + Number.EPSILON) * 1_000_000) / 1_000_000,
    }))
    .sort((left, right) => left.productId.localeCompare(right.productId))
}

export function bomCalculationSnapshot(input: {
  dishId: string
  dishName: string
  variantKey: string
  saleQuantity: number
  version: BomVersionLike
}) {
  return {
    dishId: input.dishId,
    dishName: input.dishName,
    variantKey: input.variantKey,
    saleQuantity: input.saleQuantity,
    bomVersionId: input.version.id,
    bomVersionNo: input.version.versionNo,
    effectiveFrom: calendarDate(input.version.effectiveFrom),
    items: input.version.items.map(item => ({
      productId: item.productId,
      quantity: Number(item.quantity),
      lossRate: Number(item.lossRate),
    })),
  }
}
