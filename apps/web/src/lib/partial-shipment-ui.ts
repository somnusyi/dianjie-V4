/**
 * 部分发货 UI 纯函数
 *
 * 前端发货表单的行计算、确认文案、API fulfillment 映射。
 * 规则: 首次有效发货后，不论全量或部分，所有未发余量立即关闭并释放预占，之后不补送。
 */

export type OrderItemForShip = {
  id: string
  productId: string
  quantity: string | number
  shippedQty?: string | number | null
  unitPrice: string | number
  product?: { name?: string | null; unit?: string | null; shipUpperPct?: string | number; shipUpperBuffer?: string | number } | null
}

export type ShipQtyMap = Record<string, number>

export type PartialShipmentLine = {
  it: OrderItemForShip
  orig: number
  previous: number
  remaining: number
  sq: number
  changed: boolean
}

export type FulfillmentLine = {
  itemId: string
  productId: string
  productName?: string | null
  orderedQty: number
  shippedQty: number
  closedQty: number
}

export type FulfillmentResult = {
  policy: string
  remainderClosed: boolean
  hasClosedRemainder: boolean
  isPartial: boolean
  lines: FulfillmentLine[]
}

export function buildPartialShipmentLines(
  items: OrderItemForShip[],
  shipQty: ShipQtyMap,
): PartialShipmentLine[] {
  return items.map(it => {
    const orig = Number(it.quantity)
    const previous = Number(it.shippedQty || 0)
    const remaining = Math.max(0, orig - previous)
    const sq = shipQty[it.id] != null ? shipQty[it.id] : remaining
    return {
      it,
      orig,
      previous,
      remaining,
      sq,
      changed: Math.abs(sq - remaining) > 0.0001,
    }
  })
}

export function computeShipmentNewTotal(lines: PartialShipmentLine[]): number {
  return lines.reduce((s, l) => s + l.sq * Number(l.it.unitPrice), 0)
}

export function hasAnyPositiveShipment(lines: PartialShipmentLine[]): boolean {
  return lines.some(l => l.sq > 0)
}

export function getClosedRemainderLines(
  lines: PartialShipmentLine[],
): { name: string; ordered: number; shipped: number; closed: number; unit: string }[] {
  return lines
    .filter(l => l.remaining - l.sq > 0.0001)
    .map(l => ({
      name: l.it.product?.name || '商品',
      ordered: l.orig,
      shipped: l.sq,
      closed: l.remaining - l.sq,
      unit: l.it.product?.unit || '',
    }))
}

export function buildShipmentConfirmBody(params: {
  itemCount: number
  lines: PartialShipmentLine[]
  newTotal: number
  oldTotal: number
  inventoryMode?: 'NOT_TRACKED' | 'STRICT'
  fulfillment?: FulfillmentResult | null
}): string {
  const { itemCount, lines, newTotal, oldTotal, inventoryMode, fulfillment } = params
  const changed = lines.filter(l => l.changed)
  const closedLines = getClosedRemainderLines(lines)

  let body = `${itemCount} 件商品`
  if (changed.length > 0) {
    body += `\n⚠ 已调整 ${changed.length} 项: ${changed.slice(0, 3).map(l => `${l.it.product?.name || ''} 剩余${l.remaining}→本次${l.sq}`).join(', ')}${changed.length > 3 ? ' …' : ''}`
  }
  body += `\n本次配送金额 ¥${newTotal.toLocaleString()}`

  if (closedLines.length > 0) {
    body += `\n\n⚠ 以下未发余量本次提交后将永久关闭，不会补送:`
    for (const c of closedLines) {
      body += `\n  · ${c.name}: 未发 ${c.closed}${c.unit}（订货 ${c.ordered}，实发 ${c.shipped}）`
    }
    body += `\n如仍需上述关闭数量，必须由门店重新下单。`
  }

  body += inventoryMode === 'STRICT'
    ? `\n发货后会自动扣减供应商库存，门店收货后再更新门店库存。`
    : `\n当前未核算供应商仓库库存，本次发货不会扣供应商库存；门店收货后仍会正常更新门店库存。`

  if (fulfillment?.remainderClosed && fulfillment.hasClosedRemainder) {
    body += `\n\n策略: 首次有效发货后，所有未发余量立即关闭并释放预占，之后不补送。`
  }

  return body
}

export function mapFulfillmentToCloseSummary(apiFulfillment: {
  policy?: string
  remainderClosed?: boolean
  hasClosedRemainder?: boolean
  isPartial?: boolean
  lines?: Array<{
    itemId: string
    productId: string
    productName?: string | null
    orderedQty: number
    shippedQty: number
    closedQty: number
  }>
}): FulfillmentResult | null {
  if (!apiFulfillment || !apiFulfillment.remainderClosed) return null
  return {
    policy: apiFulfillment.policy || 'CLOSE_UNSHIPPED_REMAINDER',
    remainderClosed: true,
    hasClosedRemainder: apiFulfillment.hasClosedRemainder ?? false,
    isPartial: apiFulfillment.isPartial ?? false,
    lines: (apiFulfillment.lines || []).map(l => ({
      itemId: l.itemId,
      productId: l.productId,
      productName: l.productName || null,
      orderedQty: l.orderedQty,
      shippedQty: l.shippedQty,
      closedQty: l.closedQty,
    })),
  }
}
