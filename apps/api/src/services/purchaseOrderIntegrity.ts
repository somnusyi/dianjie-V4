import crypto from 'node:crypto'
import { Prisma } from '@dianjie/db'

type Decimalish = Prisma.Decimal | string | number

export type OrderSnapshotItem = {
  lineId: string
  productId: string
  code: string | null
  name: string
  spec: string | null
  unit: string
  quantity: string
  unitPrice: string
  amount: string
  lineOrigin: 'ORIGINAL' | 'APPROVED_REVISION' | 'LEGACY_UNKNOWN'
}

export type OrderSnapshot = {
  schemaVersion: 1
  orderNo: string
  tenantId: string
  store: { id: string; name: string }
  supplier: { id: string; name: string }
  expectedDate: string
  note: string | null
  createdBy: { id: string; name: string; role: string | null }
  items: OrderSnapshotItem[]
  totalAmount: string
  submittedAt: string
  revisionNo: number
}

export type OrderChange =
  | { kind: 'ADD_ITEM'; productId: string; after: OrderSnapshotItem }
  | { kind: 'REMOVE_ITEM'; productId: string; before: OrderSnapshotItem }
  | { kind: 'CHANGE_QTY'; productId: string; name: string; before: string; after: string }
  | { kind: 'CHANGE_EXPECTED_DATE'; before: string; after: string }
  | { kind: 'CHANGE_NOTE'; before: string | null; after: string | null }

const decimal = (value: Decimalish) => new Prisma.Decimal(value)
const decimalString = (value: Decimalish, scale: number) => decimal(value).toDecimalPlaces(scale).toFixed(scale)

export function lineAmount(quantity: Decimalish, unitPrice: Decimalish): Prisma.Decimal {
  return decimal(quantity).mul(decimal(unitPrice)).toDecimalPlaces(2)
}

export function sumOrderAmount(items: Array<{ quantity: Decimalish; unitPrice: Decimalish }>): Prisma.Decimal {
  return items.reduce(
    (sum, item) => sum.add(lineAmount(item.quantity, item.unitPrice)),
    new Prisma.Decimal(0),
  ).toDecimalPlaces(2)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export function snapshotHash(snapshot: OrderSnapshot): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(snapshot))).digest('hex')
}

type OrderForSnapshot = {
  no: string
  tenantId: string
  storeId: string
  supplierId: string
  expectedDate: Date | string
  note: string | null
  submittedAt?: Date | string | null
  createdAt: Date | string
  currentRevisionNo?: number
  store: { id: string; name: string }
  supplier: { id: string; name: string }
  createdBy: { id: string; name: string; role?: string | null }
  items: Array<{
    id: string
    productId: string
    quantity: Decimalish
    unitPrice: Decimalish
    amount: Decimalish
    originalQuantity?: Decimalish | null
    originalUnitPrice?: Decimalish | null
    originalAmount?: Decimalish | null
    lineOrigin?: 'ORIGINAL' | 'APPROVED_REVISION' | 'LEGACY_UNKNOWN'
    isActive?: boolean
    product: { code?: string | null; name: string; spec?: string | null; unit: string }
  }>
}

export function buildOrderSnapshot(
  order: OrderForSnapshot,
  mode: 'original' | 'current' = 'original',
): OrderSnapshot {
  const sourceItems = mode === 'current'
    ? order.items.filter(item => item.isActive !== false)
    : order.items.filter(item => !item.lineOrigin || item.lineOrigin === 'ORIGINAL' || item.lineOrigin === 'LEGACY_UNKNOWN')

  const items = sourceItems.map((item): OrderSnapshotItem => {
    const quantity = mode === 'original' ? item.originalQuantity ?? item.quantity : item.quantity
    const unitPrice = mode === 'original' ? item.originalUnitPrice ?? item.unitPrice : item.unitPrice
    const amount = mode === 'original' ? item.originalAmount ?? lineAmount(quantity, unitPrice) : lineAmount(quantity, unitPrice)
    return {
      lineId: item.id,
      productId: item.productId,
      code: item.product.code ?? null,
      name: item.product.name,
      spec: item.product.spec ?? null,
      unit: item.product.unit,
      quantity: decimalString(quantity, 2),
      unitPrice: decimalString(unitPrice, 2),
      amount: decimalString(amount, 2),
      lineOrigin: item.lineOrigin ?? 'ORIGINAL',
    }
  }).sort((a, b) => a.lineId.localeCompare(b.lineId))

  const totalAmount = items.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0)).toFixed(2)
  const submittedAt = order.submittedAt ?? order.createdAt

  return {
    schemaVersion: 1,
    orderNo: order.no,
    tenantId: order.tenantId,
    store: { id: order.store.id, name: order.store.name },
    supplier: { id: order.supplier.id, name: order.supplier.name },
    expectedDate: new Date(order.expectedDate).toISOString().slice(0, 10),
    note: order.note ?? null,
    createdBy: { id: order.createdBy.id, name: order.createdBy.name, role: order.createdBy.role ?? null },
    items,
    totalAmount,
    submittedAt: new Date(submittedAt).toISOString(),
    revisionNo: mode === 'current' ? order.currentRevisionNo ?? 0 : 0,
  }
}

export function diffOrderSnapshots(before: OrderSnapshot, after: OrderSnapshot): OrderChange[] {
  const changes: OrderChange[] = []
  const beforeItems = new Map(before.items.map(item => [item.productId, item]))
  const afterItems = new Map(after.items.map(item => [item.productId, item]))

  for (const [productId, item] of afterItems) {
    const previous = beforeItems.get(productId)
    if (!previous) changes.push({ kind: 'ADD_ITEM', productId, after: item })
    else if (decimal(previous.quantity).cmp(item.quantity) !== 0) {
      changes.push({ kind: 'CHANGE_QTY', productId, name: item.name, before: previous.quantity, after: item.quantity })
    }
  }
  for (const [productId, item] of beforeItems) {
    if (!afterItems.has(productId)) changes.push({ kind: 'REMOVE_ITEM', productId, before: item })
  }
  if (before.expectedDate !== after.expectedDate) {
    changes.push({ kind: 'CHANGE_EXPECTED_DATE', before: before.expectedDate, after: after.expectedDate })
  }
  if ((before.note ?? null) !== (after.note ?? null)) {
    changes.push({ kind: 'CHANGE_NOTE', before: before.note ?? null, after: after.note ?? null })
  }
  return changes
}

export function revisionType(changes: OrderChange[]):
  'ADD_ITEM' | 'REMOVE_ITEM' | 'CHANGE_QTY' | 'CHANGE_EXPECTED_DATE' | 'CHANGE_NOTE' | 'MIXED' {
  const kinds = [...new Set(changes.map(change => change.kind))]
  return kinds.length === 1 ? kinds[0] : 'MIXED'
}

export function businessNoFloor(no: string | null | undefined, prefix: string, period: string): number {
  if (!no) return 0
  const head = `${prefix}${period}`
  if (!no.startsWith(head)) return 0
  const suffix = no.slice(head.length)
  if (!/^\d+$/.test(suffix)) return 0
  const value = Number(suffix)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export async function nextBusinessNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  scope: string,
  period: string,
  prefix: string,
  floor = 0,
): Promise<string> {
  if (floor > 0) {
    await tx.businessSequence.updateMany({
      where: { tenantId, scope, period, value: { lt: floor } },
      data: { value: floor },
    })
  }
  const sequence = await tx.businessSequence.upsert({
    where: { tenantId_scope_period: { tenantId, scope, period } },
    create: { tenantId, scope, period, value: Math.max(1, floor + 1) },
    update: { value: { increment: 1 } },
    select: { value: true },
  })
  return `${prefix}${period}${String(sequence.value).padStart(6, '0')}`
}
