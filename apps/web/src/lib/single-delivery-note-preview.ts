import {
  calculateOrderEntryLineAmount,
  sumOrderEntryLineAmounts,
} from './order-entry-cost-pricing'

export const SINGLE_DELIVERY_NOTE_PREVIEW_PREFIX = 'dianjie:single-order-print-preview:'
export const SINGLE_DELIVERY_NOTE_PREVIEW_INDEX_PREFIX = 'dianjie:single-order-print-preview-latest:'
export const SINGLE_DELIVERY_NOTE_PREVIEW_TTL_MS = 30 * 60 * 1000

export type SingleDeliveryNoteVersionSource = {
  id: string
  rowVersion?: number
  status: string
  deliveries?: Array<{
    id: string
    rowVersion?: number
    status: string
    receipt?: unknown
  }>
}

export type SingleDeliveryNoteDraftRow = {
  key: string
  itemId?: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  pendingRemoval?: boolean
}

export type SingleDeliveryNotePreviewItem = {
  id: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  amount: number
}

export type SingleDeliveryNotePreviewPayload = {
  schemaVersion: 1
  orderId: string
  ownerUserId: string
  tenantKey: string
  createdAt: number
  expiresAt: number
  serverSignature: string
  items: SingleDeliveryNotePreviewItem[]
  totalAmount: number
}

export type SingleDeliveryNoteDocument = {
  totalAmount: string
  costAmount?: string | null
  items: Array<{
    id: string
    quantity: string
    shippedQty: string | null
    unitPrice: string
    amount: string
    costAmount?: string | null
    product?: { name: string; spec: string | null; unit: string; code: string }
  }>
}

function hasAtMostTwoDecimals(value: number) {
  return Math.abs(value * 100 - Math.round(value * 100)) < 0.000001
}

/**
 * Match Prisma Decimal's non-negative ROUND_HALF_UP line-money rule without
 * letting binary floating point decide a half-cent boundary such as
 * 2.01 * 0.50. Zero quantity is a real delivery-note row, not an invalid one.
 */
export function calculateSingleDeliveryNoteLineAmount(
  quantity: number,
  unitPrice: number,
): number | null {
  if (!Number.isFinite(quantity) || quantity < 0
    || !Number.isFinite(unitPrice) || unitPrice < 0) return null
  if (quantity === 0 || unitPrice === 0) return 0
  const amount = calculateOrderEntryLineAmount(quantity, unitPrice)
  return amount === null ? null : Number(amount)
}

export function calculateSingleDeliveryNoteTotal(
  rows: Pick<SingleDeliveryNoteDraftRow, 'quantity' | 'unitPrice' | 'pendingRemoval'>[],
): number | null {
  const amounts = rows.filter(row => !row.pendingRemoval).map(row => {
    const amount = calculateSingleDeliveryNoteLineAmount(Number(row.quantity), Number(row.unitPrice))
    return amount === null ? null : amount.toFixed(2)
  })
  const total = sumOrderEntryLineAmounts(amounts)
  return total === null ? null : Number(total)
}

export function singleOrderServerSignature(source: SingleDeliveryNoteVersionSource): string {
  return JSON.stringify([
    source.id,
    Number(source.rowVersion),
    String(source.status || ''),
    [...(source.deliveries || [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(delivery => [
        delivery.id,
        Number(delivery.rowVersion),
        String(delivery.status || ''),
        Boolean(delivery.receipt),
      ]),
  ])
}

export function buildSingleDeliveryNoteSnapshot(rows: SingleDeliveryNoteDraftRow[]): {
  items: SingleDeliveryNotePreviewItem[]
  totalAmount: number
} {
  if (rows.length > 5000) throw new Error('商品明细过多，暂不能生成送货单')
  const items = rows.filter(row => !row.pendingRemoval).map(row => {
    const quantity = Number(row.quantity)
    const unitPrice = Number(row.unitPrice)
    const amount = calculateSingleDeliveryNoteLineAmount(quantity, unitPrice)
    return {
      id: String(row.itemId || row.key),
      productId: String(row.productId || ''),
      name: String(row.name || '').trim(),
      spec: row.spec == null ? null : String(row.spec),
      unit: String(row.unit || '').trim(),
      quantity,
      unitPrice,
      amount: amount ?? Number.NaN,
    }
  })
  if (items.some(item => !item.id || !item.productId || !item.name || !item.unit
    || !Number.isFinite(item.quantity) || item.quantity < 0
    || !Number.isFinite(item.unitPrice) || item.unitPrice < 0
    || !Number.isFinite(item.amount) || item.amount < 0
    || !hasAtMostTwoDecimals(item.quantity)
    || !hasAtMostTwoDecimals(item.unitPrice)
    || !hasAtMostTwoDecimals(item.amount))) {
    throw new Error('商品明细存在无效数据，请核对后再打开送货单')
  }
  const totalAmount = calculateSingleDeliveryNoteTotal(rows)
  if (totalAmount === null) throw new Error('商品明细存在无效数据，请核对后再打开送货单')
  return { items, totalAmount }
}

export function buildSingleOrderPreviewPayload(args: {
  order: SingleDeliveryNoteVersionSource
  ownerUserId: string
  tenantKey: string
  rows: SingleDeliveryNoteDraftRow[]
  now?: number
}): SingleDeliveryNotePreviewPayload {
  if (!args.ownerUserId || !args.tenantKey) throw new Error('当前账号信息不完整，请重新登录后再打开送货单')
  const snapshot = buildSingleDeliveryNoteSnapshot(args.rows)
  const now = args.now ?? Date.now()
  return {
    schemaVersion: 1,
    orderId: args.order.id,
    ownerUserId: args.ownerUserId,
    tenantKey: args.tenantKey,
    createdAt: now,
    expiresAt: now + SINGLE_DELIVERY_NOTE_PREVIEW_TTL_MS,
    serverSignature: singleOrderServerSignature(args.order),
    ...snapshot,
  }
}

export function parseSingleOrderPreviewPayload(args: {
  raw: string
  orderId: string
  ownerUserId: string
  tenantKey: string
  now?: number
}): SingleDeliveryNotePreviewPayload | null {
  try {
    const payload = JSON.parse(args.raw) as Partial<SingleDeliveryNotePreviewPayload>
    const createdAt = Number(payload.createdAt)
    const expiresAt = Number(payload.expiresAt)
    const now = args.now ?? Date.now()
    if (payload.schemaVersion !== 1 || payload.orderId !== args.orderId
      || !args.ownerUserId || payload.ownerUserId !== args.ownerUserId
      || !args.tenantKey || payload.tenantKey !== args.tenantKey
      || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || createdAt <= 0 || createdAt > now || expiresAt <= now
      || expiresAt - createdAt !== SINGLE_DELIVERY_NOTE_PREVIEW_TTL_MS
      || typeof payload.serverSignature !== 'string' || !payload.serverSignature
      || !Array.isArray(payload.items) || payload.items.length > 5000) return null

    const items = payload.items.map((item, index): SingleDeliveryNotePreviewItem | null => {
      const id = String(item?.id || `live:${index}`)
      const productId = String(item?.productId || '')
      const name = String(item?.name || '').trim()
      const unit = String(item?.unit || '').trim()
      const quantity = Number(item?.quantity)
      const unitPrice = Number(item?.unitPrice)
      const amount = Number(item?.amount)
      const expectedAmount = calculateSingleDeliveryNoteLineAmount(quantity, unitPrice)
      if (!id || !productId || !name || !unit
        || !Number.isFinite(quantity) || quantity < 0
        || !Number.isFinite(unitPrice) || unitPrice < 0
        || !Number.isFinite(amount) || amount < 0
        || !hasAtMostTwoDecimals(quantity)
        || !hasAtMostTwoDecimals(unitPrice)
        || !hasAtMostTwoDecimals(amount)
        || expectedAmount === null
        || Math.abs(amount - expectedAmount) >= 0.000001) return null
      return {
        id,
        productId,
        name,
        spec: item?.spec == null ? null : String(item.spec),
        unit,
        quantity,
        unitPrice,
        amount,
      }
    })
    const totalAmount = Number(payload.totalAmount)
    if (items.some(item => item === null) || !Number.isFinite(totalAmount) || totalAmount < 0
      || !hasAtMostTwoDecimals(totalAmount)) return null
    const computedTotalText = sumOrderEntryLineAmounts((items as SingleDeliveryNotePreviewItem[])
      .map(item => item.amount.toFixed(2)))
    if (computedTotalText === null) return null
    const computedTotal = Number(computedTotalText)
    if (Math.abs(totalAmount - computedTotal) >= 0.000001) return null
    return {
      schemaVersion: 1,
      orderId: args.orderId,
      ownerUserId: args.ownerUserId,
      tenantKey: args.tenantKey,
      createdAt,
      expiresAt,
      serverSignature: payload.serverSignature,
      items: items as SingleDeliveryNotePreviewItem[],
      totalAmount,
    }
  } catch {
    return null
  }
}

export function applySingleOrderPreview<T extends SingleDeliveryNoteDocument>(
  normalized: T,
  preview: Pick<SingleDeliveryNotePreviewPayload, 'items' | 'totalAmount'>,
): T {
  return {
    ...normalized,
    totalAmount: String(preview.totalAmount),
    costAmount: null,
    items: preview.items.map(item => ({
      id: item.id,
      quantity: String(item.quantity),
      shippedQty: String(item.quantity),
      unitPrice: String(item.unitPrice),
      amount: String(item.amount),
      costAmount: null,
      product: {
        name: item.name,
        spec: item.spec,
        unit: item.unit,
        code: item.productId,
      },
    })),
  }
}
