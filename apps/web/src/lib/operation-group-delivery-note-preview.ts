export type OperationGroupDeliveryNoteRow = {
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  pendingRemoval?: boolean
}

export type OperationGroupDeliveryNoteItem = {
  id: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  shippedQty: number
  unitPrice: number
  amount: number
}

export type OperationGroupDeliveryNoteProjection = {
  items: OperationGroupDeliveryNoteItem[]
  totals: { quantity: number; amount: number }
}

type OperationGroupDeliveryNoteProjectionPayload = {
  draftRows: unknown
  items: unknown
  totals: unknown
}

function lineAmount(quantity: number, unitPrice: number) {
  const quantityHundredths = Math.round(quantity * 100)
  const unitPriceCents = Math.round(unitPrice * 100)
  return Math.round((quantityHundredths * unitPriceCents) / 100) / 100
}

/**
 * Build the delivery-note projection from the exact rows currently displayed
 * by the operation-group editor. Explicit removals disappear, zero-quantity
 * rows remain, and identical frozen product snapshots are merged using their
 * authoritative line amounts.
 */
export function buildOperationGroupDeliveryNoteProjection(
  rows: OperationGroupDeliveryNoteRow[],
): OperationGroupDeliveryNoteProjection {
  const merged = new Map<string, {
    productId: string
    name: string
    spec: string | null
    unit: string
    quantity: number
    amount: number
    fallbackUnitPrice: number
  }>()

  for (const row of rows) {
    if (row.pendingRemoval) continue
    const key = `${row.productId}|${row.name}|${row.spec || ''}|${row.unit}`
    const current = merged.get(key) || {
      productId: row.productId,
      name: row.name,
      spec: row.spec || null,
      unit: row.unit,
      quantity: 0,
      amount: 0,
      fallbackUnitPrice: row.unitPrice,
    }
    current.quantity += row.quantity
    // Persisted order and delivery documents round every source line to cents
    // before totals are added. Mirror that rule so a multi-order preview cannot
    // drift by one cent from the document produced immediately after saving.
    current.amount += lineAmount(row.quantity, row.unitPrice)
    merged.set(key, current)
  }

  const items = [...merged.values()].map((item, index) => ({
    id: `live:${index}:${item.productId}`,
    productId: item.productId,
    name: item.name,
    spec: item.spec,
    unit: item.unit,
    quantity: Number(item.quantity.toFixed(2)),
    shippedQty: Number(item.quantity.toFixed(2)),
    unitPrice: Number((item.quantity > 0 ? item.amount / item.quantity : item.fallbackUnitPrice).toFixed(2)),
    amount: Number(item.amount.toFixed(2)),
  }))

  return {
    items,
    totals: {
      quantity: Number(items.reduce((sum, item) => sum + item.quantity, 0).toFixed(2)),
      amount: Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2)),
    },
  }
}

function previewNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function previewText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function previewRow(value: unknown): OperationGroupDeliveryNoteRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const productId = previewText(row.productId)
  const name = previewText(row.name)
  const unit = previewText(row.unit)
  const quantity = previewNumber(row.quantity)
  const unitPrice = previewNumber(row.unitPrice)
  if (!productId || !name || !unit || quantity === null || unitPrice === null
    || (row.spec !== null && typeof row.spec !== 'string')
    || (row.pendingRemoval !== undefined && typeof row.pendingRemoval !== 'boolean')) return null
  return {
    productId,
    name,
    spec: row.spec,
    unit,
    quantity,
    unitPrice,
    pendingRemoval: row.pendingRemoval === true,
  }
}

function previewItem(value: unknown): OperationGroupDeliveryNoteItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const id = previewText(item.id)
  const productId = previewText(item.productId)
  const name = previewText(item.name)
  const unit = previewText(item.unit)
  const quantity = previewNumber(item.quantity)
  const shippedQty = previewNumber(item.shippedQty)
  const unitPrice = previewNumber(item.unitPrice)
  const amount = previewNumber(item.amount)
  if (!id || !productId || !name || !unit || quantity === null || shippedQty === null
    || unitPrice === null || amount === null || shippedQty !== quantity
    || (item.spec !== null && typeof item.spec !== 'string')) return null
  return {
    id,
    productId,
    name,
    spec: item.spec,
    unit,
    quantity,
    shippedQty,
    unitPrice,
    amount,
  }
}

function samePreviewItem(
  actual: OperationGroupDeliveryNoteItem,
  expected: OperationGroupDeliveryNoteItem,
) {
  return actual.id === expected.id
    && actual.productId === expected.productId
    && actual.name === expected.name
    && actual.spec === expected.spec
    && actual.unit === expected.unit
    && actual.quantity === expected.quantity
    && actual.shippedQty === expected.shippedQty
    && actual.unitPrice === expected.unitPrice
    && actual.amount === expected.amount
}

/**
 * Validate a stored group preview against its source rows, then return a fresh
 * projection. The printable values are never trusted independently from the
 * rows that produced them.
 */
export function parseOperationGroupDeliveryNoteProjection(
  payload: OperationGroupDeliveryNoteProjectionPayload,
): OperationGroupDeliveryNoteProjection | null {
  if (!Array.isArray(payload.draftRows) || payload.draftRows.length > 5000
    || !Array.isArray(payload.items) || payload.items.length > 5000
    || !payload.totals || typeof payload.totals !== 'object' || Array.isArray(payload.totals)) return null

  const rows = payload.draftRows.map(previewRow)
  const items = payload.items.map(previewItem)
  if (rows.some(row => row === null) || items.some(item => item === null)) return null

  const suppliedTotals = payload.totals as Record<string, unknown>
  const quantity = previewNumber(suppliedTotals.quantity)
  const amount = previewNumber(suppliedTotals.amount)
  if (quantity === null || amount === null) return null

  const projection = buildOperationGroupDeliveryNoteProjection(rows as OperationGroupDeliveryNoteRow[])
  if (items.length !== projection.items.length
    || items.some((item, index) => !samePreviewItem(item!, projection.items[index]))
    || quantity !== projection.totals.quantity
    || amount !== projection.totals.amount) return null
  return projection
}
