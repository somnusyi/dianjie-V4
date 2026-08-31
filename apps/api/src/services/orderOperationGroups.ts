import { createHash } from 'node:crypto'

/**
 * The warehouse screen may operate on several purchase orders at once, but
 * purchase orders remain the source of truth. This module computes a
 * read-time operation group; it never creates or mutates a purchase order.
 */
export const OPERATION_GROUP_WINDOW_MS = 2 * 60 * 60 * 1000
/** @deprecated Grouping is immediate; there is no idle/waiting gate. */
export const OPERATION_GROUP_IDLE_MS = 0

export type OperationGroupCandidate = {
  id: string
  no: string
  storeId: string
  supplierId: string
  expectedDate: Date | string
  status: string
  createdAt: Date | string
  updatedAt: Date | string
  /** Business submission time; preferred over a later import/upsert createdAt. */
  submittedAt?: Date | string | null
  /** Latest immutable order event, retained for callers/audit context. */
  lastOperationAt?: Date | string | null
  hasPendingRevision?: boolean
}

export type OperationGroup = {
  id: string
  storeId: string
  supplierId: string
  expectedDate: string
  memberOrderIds: string[]
  memberOrderNos: string[]
  memberCount: number
  firstCreatedAt: string
  lastCreatedAt: string
  /**
   * Compatibility fields retained for older clients. They no longer represent
   * a waiting deadline: a group is actionable immediately.
   */
  idleSince: string
  eligibleAt: string
  isEligible: boolean
  blockedOrderIds: string[]
}

export type OperationGroupMembership = {
  operationGroup: OperationGroup | null
  operationGroupPosition: number | null
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('订单时间无效')
  return date
}

function dateKey(value: Date | string): string {
  // expectedDate is a PostgreSQL DATE. Converting through UTC avoids a
  // timezone-dependent grouping key when Prisma returns a Date at midnight.
  return asDate(value).toISOString().slice(0, 10)
}

function groupId(memberIds: string[]): string {
  const digest = createHash('sha256').update(memberIds.join('|')).digest('hex').slice(0, 24)
  return `og_${digest}`
}

/**
 * Build deterministic groups from untouched SUBMITTED orders.
 *
 * Rules:
 * - only orders still in SUBMITTED are groupable;
 * - same store, supplier and expected arrival date are required;
 * - each group is anchored by its newest order and includes only orders in the
 *   preceding two-hour window. This is a rolling look-back window: 09:00,
 *   10:30, 11:15 produces [09:00] and [10:30, 11:15];
 * - a group is actionable immediately. There is no two-hour waiting/idle gate;
 * - one-order groups are omitted from the membership map because there is no
 *   merge/batch affordance to expose for them.
 */
export function buildOperationGroups(
  orders: OperationGroupCandidate[],
  now = new Date(),
): Map<string, OperationGroupMembership> {
  // Keep the argument for API compatibility; grouping no longer depends on the
  // current clock or on the last operation timestamp.
  void now
  const candidates = orders.map(order => ({
    ...order,
    // submittedAt is the business arrival time. createdAt remains the audit
    // display timestamp and is used for legacy rows.
    _created: asDate(order.submittedAt || order.createdAt),
    _displayCreated: asDate(order.createdAt),
  }))

  const buckets = new Map<string, Array<typeof candidates[number]>>()
  for (const candidate of candidates) {
    const key = `${candidate.storeId}|${candidate.supplierId}|${dateKey(candidate.expectedDate)}`
    const bucket = buckets.get(key) || []
    bucket.push(candidate)
    buckets.set(key, bucket)
  }

  const groups: OperationGroup[] = []
  const flush = (current: Array<typeof candidates[number]>) => {
    if (current.length < 2) return
    const ordered = [...current].sort(
      (a, b) => a._created.getTime() - b._created.getTime() || a.id.localeCompare(b.id),
    )
    const memberIds = ordered.map(order => order.id)
    const latestCreated = new Date(Math.max(...ordered.map(order => order._created.getTime())))
    groups.push({
      id: groupId(memberIds),
      storeId: ordered[0].storeId,
      supplierId: ordered[0].supplierId,
      expectedDate: dateKey(ordered[0].expectedDate),
      memberOrderIds: memberIds,
      memberOrderNos: ordered.map(order => order.no),
      memberCount: ordered.length,
      firstCreatedAt: ordered[0]._displayCreated.toISOString(),
      lastCreatedAt: ordered[ordered.length - 1]._displayCreated.toISOString(),
      // Deprecated compatibility values; no waiting is enforced.
      idleSince: latestCreated.toISOString(),
      eligibleAt: latestCreated.toISOString(),
      isEligible: true,
      blockedOrderIds: ordered.filter(order => order.hasPendingRevision).map(order => order.id),
    })
  }

  for (const bucket of buckets.values()) {
    // Descending order makes the newest pending order the anchor. An older
    // order can join only when anchor - older <= 2h; it can never pull a later
    // order into an earlier window.
    const sorted = [...bucket]
      .sort((a, b) => b._created.getTime() - a._created.getTime() || b.id.localeCompare(a.id))
    let current: Array<typeof candidates[number]> = []
    let anchor: typeof candidates[number] | null = null
    for (const order of sorted) {
      // An already-operated row is not a member and remains a boundary. This
      // prevents a newly pending run from silently reaching across an order
      // that has already entered the original workflow.
      if (order.status !== 'SUBMITTED') {
        flush(current)
        current = []
        anchor = null
        continue
      }
      if (!anchor) {
        anchor = order
        current = [order]
        continue
      }
      const withinWindow =
        anchor._created.getTime() - order._created.getTime() <= OPERATION_GROUP_WINDOW_MS
      if (!withinWindow) {
        flush(current)
        anchor = order
        current = [order]
        continue
      }
      current.push(order)
    }
    flush(current)
  }

  const memberships = new Map<string, OperationGroupMembership>()
  for (const group of groups) {
    group.memberOrderIds.forEach((id, position) => {
      memberships.set(id, { operationGroup: group, operationGroupPosition: position })
    })
  }
  return memberships
}

/** Compute the operation group id without exposing any tenant data. */
export function operationGroupId(memberOrderIds: string[]): string {
  return groupId(memberOrderIds)
}
