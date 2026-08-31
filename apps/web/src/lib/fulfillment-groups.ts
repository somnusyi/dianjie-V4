export type FulfillmentOrderLike = {
  id: string
  no?: string
  status?: string
  createdAt: string
  submittedAt?: string | null
  updatedAt?: string | null
  store?: { id?: string; name?: string } | null
  supplier?: { id?: string; name?: string } | null
  expectedDate?: string | null
  operationGroup?: OperationGroup | null
}

/**
 * Metadata returned by GET /api/orders for orders that can be operated as a
 * group.  The server remains the source of truth for eligibility; the client
 * only uses this object to render and route a group action.
 */
export type OperationGroup = {
  id: string
  storeId?: string | null
  supplierId?: string | null
  expectedDate?: string | null
  memberCount?: number
  memberOrderNos?: string[]
  memberOrderIds?: string[]
  firstCreatedAt?: string | null
  lastCreatedAt?: string | null
  idleSince?: string | null
  eligibleAt?: string | null
  isEligible?: boolean
  blockedOrderIds?: string[]
  position?: number
}

export type FulfillmentGroup = {
  id: string
  orders: FulfillmentOrderLike[]
  metadata: OperationGroup | null
  /** true when a server group (or a safe local fallback) contains > 1 order. */
  isGrouped: boolean
  /** Group action is enabled only when the server explicitly says so. */
  canBatchConfirm: boolean
}

/**
 * Return the id that owns a group-level add-product request.
 *
 * The server emits memberOrderIds in business-time order (submittedAt, then
 * createdAt). Prefer that authoritative list even when pagination means the
 * current page contains only part of the group; fall back to the visible rows
 * for older API responses that do not expose membership ids.
 */
export function latestFulfillmentGroupOrderId(
  group: Pick<FulfillmentGroup, 'orders' | 'metadata'>,
): string | null {
  const memberOrderIds = group.metadata?.memberOrderIds || []
  if (memberOrderIds.length > 0) return memberOrderIds[memberOrderIds.length - 1] || null
  const visible = [...group.orders]
    .filter(order => Boolean(order.id))
    .sort((a, b) => {
      const aTime = Date.parse(a.submittedAt || a.createdAt)
      const bTime = Date.parse(b.submittedAt || b.createdAt)
      return bTime - aTime || b.id.localeCompare(a.id)
    })
  return visible[0]?.id || null
}

function orderStoreId(order: FulfillmentOrderLike): string {
  return order.store?.id || order.store?.name || 'unknown-store'
}

function orderSupplierId(order: FulfillmentOrderLike): string {
  return order.supplier?.id || order.supplier?.name || 'unknown-supplier'
}

function expectedDay(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : ''
}

/**
 * A deliberately conservative fallback for older API responses.  It groups
 * only untouched SUBMITTED orders from the same store/supplier/expected day
 * whose creation timestamps are at most two hours apart.  Because the old API
 * does not expose idle/eligibility state, the resulting group is display-only
 * and cannot trigger a batch mutation.
 */
function fallbackKey(order: FulfillmentOrderLike): string | null {
  if (order.status !== 'SUBMITTED') return null
  return [orderStoreId(order), orderSupplierId(order), expectedDay(order.expectedDate)].join('|')
}

function fallbackGroups(orders: FulfillmentOrderLike[]): FulfillmentGroup[] {
  const byKey = new Map<string, FulfillmentOrderLike[]>()
  for (const order of orders) {
    const key = fallbackKey(order)
    if (!key) continue
    const list = byKey.get(key) || []
    list.push(order)
    byKey.set(key, list)
  }
  const result: FulfillmentGroup[] = []
  for (const list of byKey.values()) {
    // Anchor at the newest order and look backwards two hours. This mirrors
    // the server rule and avoids chaining an early order into a later window.
    const sorted = [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
    let window: FulfillmentOrderLike[] = []
    let anchor: FulfillmentOrderLike | null = null
    const flush = () => {
      if (window.length > 1) {
        const ordered = [...window].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
        const id = 'local:' + fallbackKey(ordered[0]) + ':' + ordered.map(item => item.id).join(',')
        result.push({ id, orders: ordered, metadata: null, isGrouped: true, canBatchConfirm: false })
      }
      window = []
    }
    for (const order of sorted) {
      if (order.status !== 'SUBMITTED') {
        flush()
        anchor = null
        continue
      }
      if (!anchor) {
        anchor = order
        window = [order]
        continue
      }
      if (Date.parse(anchor.createdAt) - Date.parse(order.createdAt) > 2 * 60 * 60 * 1000) {
        flush()
        anchor = order
        window = [order]
      } else {
        window.push(order)
      }
    }
    flush()
  }
  return result
}

/**
 * Build stable display groups from API rows.  Rows carrying the same
 * operationGroup.id are grouped even if the API returned them out of order;
 * ungrouped rows remain one-order groups.  The output follows the first row's
 * position so existing order sorting is preserved.
 */
export function buildFulfillmentGroups<T extends FulfillmentOrderLike>(orders: T[]): Array<FulfillmentGroup & { orders: T[] }> {
  const indexed = orders.map((order, index) => ({ order, index }))
  const byGroup = new Map<string, { metadata: OperationGroup | null; rows: Array<{ order: T; index: number }> }>()
  const fallback = fallbackGroups(orders)
  const fallbackByOrder = new Map<string, FulfillmentGroup>()
  fallback.forEach(group => group.orders.forEach(order => fallbackByOrder.set(order.id, group)))

  for (const row of indexed) {
    const metadata = row.order.operationGroup || null
    if (metadata?.id) {
      const current = byGroup.get(`server:${metadata.id}`) || { metadata, rows: [] }
      current.rows.push(row)
      // Prefer the newest metadata shape if one row has the member list.
      if ((metadata.memberOrderIds?.length || 0) > (current.metadata?.memberOrderIds?.length || 0)) current.metadata = metadata
      byGroup.set(`server:${metadata.id}`, current)
      continue
    }
    const local = fallbackByOrder.get(row.order.id)
    if (local) {
      const key = `local:${local.id}`
      const current = byGroup.get(key) || { metadata: null, rows: [] }
      current.rows.push(row)
      byGroup.set(key, current)
      continue
    }
    byGroup.set(`single:${row.order.id}`, { metadata: null, rows: [row] })
  }

  return [...byGroup.values()]
    .map(group => {
      const rows = group.rows.sort((a, b) => a.index - b.index)
      const metadata = group.metadata
      // The list endpoint may return only part of a group when a search or
      // pagination boundary cuts through it.  The server member count is the
      // authoritative indication that this is still a collection; do not
      // disable its action merely because the current page has one row.
      const isGrouped = rows.length > 1 || Boolean(metadata?.id && (metadata.memberCount || 0) > 1)
      return {
        id: metadata?.id || `single:${rows[0].order.id}`,
        orders: rows.map(row => row.order),
        metadata,
        isGrouped,
        // Never infer write eligibility from timestamps on the client.
        canBatchConfirm: Boolean(metadata?.id && isGrouped && metadata.isEligible === true),
        firstIndex: rows[0].index,
      }
    })
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ firstIndex: _firstIndex, ...group }) => group as FulfillmentGroup & { orders: T[] })
}

export function groupTimeLabel(group: FulfillmentGroup): string | null {
  const values = group.orders.map(order => Date.parse(order.createdAt)).filter(Number.isFinite)
  if (!values.length) return null
  const first = new Date(Math.min(...values))
  const last = new Date(Math.max(...values))
  const format = (date: Date) => date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  return first.getTime() === last.getTime() ? format(first) : `${format(first)}—${format(last)}`
}

export function groupIdleHint(group: FulfillmentGroup): string | null {
  const metadata = group.metadata
  if (!metadata || !group.isGrouped) return null
  if (metadata.isEligible === true) return '同店两小时窗口，可批量接单'
  return '同店两小时窗口，等待系统刷新'
}
