import { Prisma, prisma } from '@dianjie/db'
import { supplyDataReadScope } from '../lib/internal-supply-chain-access'
import {
  buildOperationGroups,
  operationGroupId,
  type OperationGroup,
  type OperationGroupCandidate,
} from './orderOperationGroups'
import { withDocumentProductSnapshot } from '../lib/supply-document-snapshot'

/**
 * Read-only detail for a two-hour operation group.
 *
 * Operation groups are deliberately not persisted as orders (or as a new
 * database table). Pending groups are recomputed from the same source rows as
 * the order list; after batch acceptance the immutable ACCEPTED events carry
 * the group id and member position, which lets the print page reconstruct the
 * same collection without inventing a synthetic order number.
 */

export type OperationGroupDetailUser = {
  tenantId: string
  role?: string | null
  storeId?: string | null
  storeIds?: string[] | null
  supplierId?: string | null
}

export type OperationGroupDetailLine = {
  id: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: string
  shippedQty: string | null
  unitPrice: string
  amount: string
  sourceOrderNos: string[]
}

export type OperationGroupDetail = {
  group: OperationGroup
  source: 'pending' | 'accepted'
  orders: Array<Record<string, unknown>>
  mergedItems: OperationGroupDetailLine[]
  totals: {
    quantity: string
    amount: string
    orderedQuantity: string
    orderedAmount: string
    originalOrderAmount: string
    shipmentQuantity: string
    shipmentAmount: string
    hasAnyShipment: boolean
    snapshotComplete: boolean
  }
  progressStep: number
}

export type OperationGroupOrderTimeLike = {
  id: string
  createdAt: Date | string
  submittedAt?: Date | string | null
}

function operationGroupBusinessTime(order: OperationGroupOrderTimeLike): number {
  const value = order.submittedAt || order.createdAt
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

/**
 * The default owner for a group-level add-product request is deterministic:
 * the member with the latest business order time. This mirrors the grouping
 * service's submittedAt-first ordering and uses the id as a stable tie-break.
 */
export function latestOperationGroupOrderId(
  orders: OperationGroupOrderTimeLike[],
): string | null {
  return [...orders]
    .filter(order => Boolean(order?.id))
    .sort((a, b) => operationGroupBusinessTime(b) - operationGroupBusinessTime(a) || b.id.localeCompare(a.id))[0]?.id || null
}

function decimalString(value: unknown, fallback = '0.00'): string {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

function decimalValue(value: unknown, fallback = '0'): Prisma.Decimal {
  try {
    return new Prisma.Decimal(value === null || value === undefined || value === '' ? fallback : String(value))
  } catch {
    return new Prisma.Decimal(fallback)
  }
}

export function operationGroupShipmentSummary(orders: Array<{ deliveries?: Array<{ status?: string | null; actualTotalAmount?: unknown }> }>) {
  const validDeliveries = orders.flatMap(order => (order.deliveries || [])
    .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED'))
  return {
    shipmentAmount: validDeliveries.reduce((sum, delivery) => sum.add(decimalValue(delivery.actualTotalAmount)), new Prisma.Decimal(0)).toFixed(2),
    hasAnyShipment: validDeliveries.length > 0,
    snapshotComplete: orders.every(order => (order.deliveries || [])
      .some(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')),
  }
}

function numberValue(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function dateText(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString()
}

function expectedDateKey(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value || '').slice(0, 10) : date.toISOString().slice(0, 10)
}

function activeDelivery(order: any): any | null {
  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : []
  return [...deliveries]
    .filter(delivery => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
    .sort((a, b) => dateText(b.shippedAt || b.createdAt).localeCompare(dateText(a.shippedAt || a.createdAt)))[0] || null
}

function sourceLines(order: any): Array<any> {
  const delivery = activeDelivery(order)
  if (delivery && Array.isArray(delivery.items) && delivery.items.length > 0) {
    return delivery.items.map((raw: any) => {
      const item = withDocumentProductSnapshot(raw)
      const product = item.product || {}
      const quantity = item.shippedQty == null ? item.orderedQtySnapshot : item.shippedQty
      return {
        id: item.id,
        productId: item.productId,
        name: String(product.name || '—'),
        spec: product.spec == null ? null : String(product.spec),
        unit: String(product.unit || '—'),
        quantity: decimalString(quantity),
        shippedQty: item.shippedQty == null ? null : decimalString(item.shippedQty),
        unitPrice: decimalString(item.unitPriceSnapshot),
        amount: decimalString(item.amount),
      }
    })
  }

  return (Array.isArray(order.items) ? order.items : [])
    .filter((item: any) => item.isActive !== false)
    .map((raw: any) => {
      const item = withDocumentProductSnapshot(raw)
      const product = item.product || {}
      const quantity = item.shippedQty == null ? item.quantity : item.shippedQty
      const unitPrice = decimalString(item.unitPrice)
      const amount = item.shippedQty == null
        ? decimalString(item.amount)
        : decimalValue(quantity).mul(decimalValue(unitPrice)).toFixed(2)
      return {
        id: item.id,
        productId: item.productId,
        name: String(product.name || '—'),
        spec: product.spec == null ? null : String(product.spec),
        unit: String(product.unit || '—'),
        quantity: decimalString(quantity),
        shippedQty: item.shippedQty == null ? null : decimalString(item.shippedQty),
        unitPrice,
        amount,
      }
    })
}

function orderedLines(order: any): Array<any> {
  return (Array.isArray(order.items) ? order.items : [])
    .filter((item: any) => item.isActive !== false)
    .map((raw: any) => {
      const item = withDocumentProductSnapshot(raw)
      const product = item.product || {}
      return {
        id: item.id,
        productId: item.productId,
        name: String(product.name || '—'),
        spec: product.spec == null ? null : String(product.spec),
        unit: String(product.unit || '—'),
        quantity: decimalString(item.quantity),
        shippedQty: item.shippedQty == null ? null : decimalString(item.shippedQty),
        unitPrice: decimalString(item.unitPrice),
        amount: decimalString(item.amount),
      }
    })
}

function deliverySnapshotLines(delivery: any): Array<any> {
  return (Array.isArray(delivery?.items) ? delivery.items : []).map((raw: any) => {
    const item = withDocumentProductSnapshot(raw)
    const product = item.product || {}
    return {
      id: item.id,
      productId: item.productId,
      name: String(product.name || '—'),
      spec: product.spec == null ? null : String(product.spec),
      unit: String(product.unit || '—'),
      quantity: decimalString(item.shippedQty),
      shippedQty: decimalString(item.shippedQty),
      unitPrice: decimalString(item.unitPriceSnapshot),
      amount: decimalString(item.amount),
    }
  })
}

function shipmentLines(order: any): Array<any> {
  const deliveries = (Array.isArray(order.deliveries) ? order.deliveries : [])
    .filter((delivery: any) => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
  return deliveries.flatMap(deliverySnapshotLines)
}

/** Pure, deterministic product merge used by the API and unit tests. */
export function mergeOperationGroupItems(orders: Array<{ no: string; items: Array<any> }>): OperationGroupDetailLine[] {
  const merged = new Map<string, {
    productId: string
    name: string
    spec: string | null
    unit: string
    quantity: Prisma.Decimal
    amount: Prisma.Decimal
    sourceOrderNos: string[]
  }>()

  for (const order of orders) {
    for (const item of order.items || []) {
      const productId = String(item.productId || '')
      if (!productId) continue
      const quantity = decimalValue(item.quantity)
      if (quantity.lte(0)) continue
      const name = String(item.name || '—')
      const spec = item.spec == null ? null : String(item.spec)
      const unit = String(item.unit || '—')
      // Product id plus frozen display values prevents two historical variants
      // from being silently merged just because the current SKU was renamed.
      const key = `${productId}|${name}|${spec || ''}|${unit}`
      const current = merged.get(key) || {
        productId, name, spec, unit, quantity: new Prisma.Decimal(0), amount: new Prisma.Decimal(0), sourceOrderNos: [],
      }
      current.quantity = current.quantity.add(quantity)
      current.amount = current.amount.add(decimalValue(item.amount))
      if (!current.sourceOrderNos.includes(order.no)) current.sourceOrderNos.push(order.no)
      merged.set(key, current)
    }
  }

  return [...merged.values()].map((item, index) => ({
    id: `merged:${index}:${item.productId}`,
    productId: item.productId,
    name: item.name,
    spec: item.spec,
    unit: item.unit,
    quantity: item.quantity.toFixed(2),
    shippedQty: null,
    // A weighted price keeps the displayed line mathematically consistent
    // when historical source orders used different frozen prices. The exact
    // amount remains authoritative and is returned separately.
    unitPrice: item.quantity.gt(0) ? item.amount.div(item.quantity).toFixed(2) : '0.00',
    amount: item.amount.toFixed(2),
    sourceOrderNos: item.sourceOrderNos,
  }))
}

const detailInclude = {
  store: true,
  supplier: true,
  createdBy: { select: { id: true, name: true, role: true } },
  shippedBy: { select: { id: true, name: true, role: true } },
  items: { where: { isActive: true }, include: { product: true } },
  deliveries: {
    orderBy: { createdAt: 'asc' as const },
    include: { items: { where: { removedAt: null }, include: { product: true } } },
  },
}

function candidateOf(row: any): OperationGroupCandidate {
  return {
    id: row.id,
    no: row.no,
    storeId: row.storeId,
    supplierId: row.supplierId,
    expectedDate: row.expectedDate,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    lastOperationAt: row.events?.[0]?.occurredAt || null,
    hasPendingRevision: Boolean(row.revisions?.length),
  }
}

function groupFromAcceptedEvents(events: any[]): { group: OperationGroup; memberIds: string[] } | null {
  const byOrder = new Map<string, { id: string; index: number; occurredAt: Date }>()
  for (const event of events) {
    const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata as Record<string, unknown> : {}
    const groupId = metadata.operationGroupId
    if (typeof groupId !== 'string') continue
    const index = Number(metadata.operationGroupMemberIndex)
    if (!Number.isInteger(index) || index < 0) continue
    const current = byOrder.get(event.purchaseOrderId)
    const occurredAt = event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt)
    if (!current || occurredAt.getTime() > current.occurredAt.getTime()) {
      byOrder.set(event.purchaseOrderId, { id: event.purchaseOrderId, index, occurredAt })
    }
  }
  const ordered = [...byOrder.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
  if (ordered.length < 2) return null
  const memberIds = ordered.map(item => item.id)
  const requestedId = (events.find(event => (event.metadata as any)?.operationGroupId)?.metadata as any)?.operationGroupId
  if (typeof requestedId !== 'string' || operationGroupId(memberIds) !== requestedId) return null
  // The remaining fields are filled from the source orders after consistency
  // checks. These placeholders keep the function's output type explicit.
  return {
    group: {
      id: requestedId,
      storeId: '', supplierId: '', expectedDate: '', memberOrderIds: memberIds,
      memberOrderNos: [], memberCount: memberIds.length, firstCreatedAt: '', lastCreatedAt: '',
      idleSince: '', eligibleAt: '', isEligible: true, blockedOrderIds: [],
    },
    memberIds,
  }
}

/** Load a group using the caller's read scope. This function never writes. */
export async function loadOperationGroupDetails(
  user: OperationGroupDetailUser,
  requestedGroupId: string,
): Promise<OperationGroupDetail | null> {
  if (!/^og_[a-f0-9]{24}$/.test(requestedGroupId)) return null
  const scope: any = supplyDataReadScope(user)

  let group: OperationGroup | null = null
  let memberIds: string[] = []
  let source: 'pending' | 'accepted' = 'pending'

  // Accepted groups carry their deterministic id in immutable events. Resolve
  // that indexed path first so printing an already-accepted group does not
  // scan the tenant's entire purchase-order history.
  let acceptedEvents: any[] | null = null
  try {
    acceptedEvents = await prisma.purchaseOrderEvent.findMany({
      where: { tenantId: user.tenantId, eventType: 'ACCEPTED', metadata: { path: ['operationGroupId'], equals: requestedGroupId } } as any,
      select: { purchaseOrderId: true, metadata: true, occurredAt: true },
    })
  } catch {
    // Older datastore clients may not support JSON-path filtering. We can
    // still resolve pending groups below; accepted groups fail closed.
    acceptedEvents = null
  }
  const accepted = acceptedEvents
    ? groupFromAcceptedEvents(acceptedEvents.filter(event => (event.metadata as any)?.operationGroupId === requestedGroupId))
    : null
  if (accepted) {
    group = accepted.group
    memberIds = accepted.memberIds
    source = 'accepted'
  } else {
    const candidateRows = await prisma.purchaseOrder.findMany({
      // Keep the same boundary rows used by the list and confirm endpoints.
      // A processed order in the same bucket must prevent a pending window
      // from reaching across it.
      where: scope,
      select: {
        id: true, no: true, storeId: true, supplierId: true, expectedDate: true,
        status: true, createdAt: true, updatedAt: true, submittedAt: true,
        revisions: { where: { status: 'PENDING' }, select: { id: true } },
        events: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
      },
    })
    const memberships = buildOperationGroups(candidateRows.map(candidateOf))
    const pending = [...memberships.values()].map(item => item.operationGroup).find(item => item?.id === requestedGroupId)
    if (!pending) return null
    group = pending
    memberIds = [...pending.memberOrderIds]
  }

  const rows: any[] = await prisma.purchaseOrder.findMany({
    where: { ...scope, id: { in: memberIds } },
    include: detailInclude as any,
  })
  if (rows.length !== memberIds.length) return null
  const byId = new Map(rows.map(row => [row.id, row]))
  const orderedRows = memberIds.map(id => byId.get(id)).filter(Boolean) as any[]
  if (orderedRows.length !== memberIds.length) return null

  const first = orderedRows[0]
  const sameBoundary = orderedRows.every(row => row.storeId === first.storeId
    && row.supplierId === first.supplierId
    && expectedDateKey(row.expectedDate) === expectedDateKey(first.expectedDate))
  if (!sameBoundary) return null

  const candidates = orderedRows.map(candidateOf)
  if (source === 'accepted') {
    const calculatedId = operationGroupId(candidates
      .sort((a, b) => new Date(a.submittedAt || a.createdAt).getTime() - new Date(b.submittedAt || b.createdAt).getTime() || a.id.localeCompare(b.id))
      .map(row => row.id))
    if (calculatedId !== requestedGroupId) return null
    const sorted = [...orderedRows].sort((a, b) => new Date(a.submittedAt || a.createdAt).getTime() - new Date(b.submittedAt || b.createdAt).getTime() || a.id.localeCompare(b.id))
    memberIds = sorted.map(row => row.id)
    orderedRows.splice(0, orderedRows.length, ...sorted)
  }

  group = {
    ...(group as OperationGroup),
    id: requestedGroupId,
    storeId: first.storeId,
    supplierId: first.supplierId,
    expectedDate: expectedDateKey(first.expectedDate),
    memberOrderIds: memberIds,
    memberOrderNos: orderedRows.map(row => row.no),
    memberCount: orderedRows.length,
    firstCreatedAt: dateText(orderedRows[0].createdAt),
    lastCreatedAt: dateText(orderedRows[orderedRows.length - 1].createdAt),
  }

  const printableOrders = orderedRows.map(row => ({
    id: row.id,
    no: row.no,
    rowVersion: row.rowVersion,
    deliveryNo: activeDelivery(row)?.no || null,
    deliveryNos: (Array.isArray(row.deliveries) ? row.deliveries : [])
      .filter((delivery: any) => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
      .map((delivery: any) => String(delivery.no)),
    deliverySummaries: (Array.isArray(row.deliveries) ? row.deliveries : [])
      .filter((delivery: any) => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED')
      .sort((a: any, b: any) => dateText(a.shippedAt || a.createdAt).localeCompare(dateText(b.shippedAt || b.createdAt)))
      .map((delivery: any) => ({ no: String(delivery.no), items: deliverySnapshotLines(delivery) })),
    createdAt: dateText(row.createdAt),
    submittedAt: row.submittedAt ? dateText(row.submittedAt) : null,
    expectedDate: expectedDateKey(row.expectedDate),
    status: row.status,
    shippedAt: row.shippedAt ? dateText(row.shippedAt) : null,
    store: row.store ? {
      id: row.store.id, name: row.store.name, no: row.store.no,
      address: row.store.address || null, managerName: row.store.managerName || null,
      phone: row.store.phone || null,
    } : null,
    supplier: row.supplier ? {
      id: row.supplier.id, name: row.supplier.name,
      contactName: row.supplier.contactName || null, contactPhone: row.supplier.contactPhone || null,
    } : null,
    createdBy: row.createdBy || null,
    shippedBy: row.shippedBy || null,
    consignee: { name: row.store?.managerName || null, phone: row.store?.phone || null },
    items: sourceLines(row),
    orderedItems: orderedLines(row),
    shipmentItems: shipmentLines(row),
  }))
  const orderedMergedItems = mergeOperationGroupItems(printableOrders.map(order => ({
    no: order.no,
    items: order.orderedItems,
  })))
  const shipmentMergedItems = mergeOperationGroupItems(printableOrders.map(order => ({
    no: order.no,
    items: order.shipmentItems,
  })))
  const shipmentSummary = operationGroupShipmentSummary(orderedRows)
  const validDeliveries = orderedRows.flatMap(row => (Array.isArray(row.deliveries) ? row.deliveries : [])
    .filter((delivery: any) => delivery.status !== 'DRAFT' && delivery.status !== 'CANCELLED'))
  const { hasAnyShipment, snapshotComplete, shipmentAmount } = shipmentSummary
  // Once shipment snapshots exist, the aggregate product view contains only
  // shipment lines. Never fill missing members with ordered quantities.
  const mergedItems = hasAnyShipment ? shipmentMergedItems : orderedMergedItems
  const shipmentQuantity = shipmentMergedItems.reduce((sum, item) => sum.add(decimalValue(item.quantity)), new Prisma.Decimal(0)).toFixed(2)
  const totals = {
    quantity: mergedItems.reduce((sum, item) => sum.add(decimalValue(item.quantity)), new Prisma.Decimal(0)).toFixed(2),
    amount: hasAnyShipment
      ? shipmentAmount
      : orderedMergedItems.reduce((sum, item) => sum.add(decimalValue(item.amount)), new Prisma.Decimal(0)).toFixed(2),
    orderedQuantity: orderedMergedItems.reduce((sum, item) => sum.add(decimalValue(item.quantity)), new Prisma.Decimal(0)).toFixed(2),
    orderedAmount: orderedMergedItems.reduce((sum, item) => sum.add(decimalValue(item.amount)), new Prisma.Decimal(0)).toFixed(2),
    originalOrderAmount: orderedRows.reduce((sum, row) => sum.add(decimalValue(row.originalTotalAmount ?? row.totalAmount)), new Prisma.Decimal(0)).toFixed(2),
    shipmentQuantity,
    shipmentAmount,
    hasAnyShipment,
    snapshotComplete,
  }
  const progressStep = source === 'pending' ? 0
    : orderedRows.every(row => row.receivedAt) ? 4
      : validDeliveries.length > 0 && validDeliveries.every((delivery: any) => ['DELIVERED', 'RECEIVED'].includes(String(delivery.status))) ? 3
        : validDeliveries.length > 0 ? 2 : 1
  return { group, source, orders: printableOrders, mergedItems, totals, progressStep }
}
