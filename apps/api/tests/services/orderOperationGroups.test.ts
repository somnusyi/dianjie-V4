import { describe, expect, it } from 'vitest'
import {
  OPERATION_GROUP_IDLE_MS,
  OPERATION_GROUP_WINDOW_MS,
  buildOperationGroups,
} from '../../src/services/orderOperationGroups'

const base = {
  storeId: 'store-1',
  supplierId: 'warehouse-1',
  expectedDate: '2026-09-01T00:00:00.000Z',
  status: 'SUBMITTED',
}

function order(id: string, createdAt: string, updatedAt = createdAt, extra: Record<string, unknown> = {}) {
  return { ...base, id, no: id.toUpperCase(), createdAt, updatedAt, ...extra }
}

function groupsOf(memberships: ReturnType<typeof buildOperationGroups>) {
  return [...new Map(
    [...memberships.values()]
      .filter(item => item.operationGroup)
      .map(item => [item.operationGroup!.id, item.operationGroup!]),
  ).values()]
}

describe('order operation groups', () => {
  it('anchors at the newest order and looks backwards two hours', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T09:00:00.000Z'),
      order('b', '2026-08-31T10:30:00.000Z'),
      order('c', '2026-08-31T11:15:00.000Z'),
    ])
    const groups = groupsOf(memberships)
    expect(groups).toHaveLength(1)
    expect(groups[0].memberOrderIds).toEqual(['b', 'c'])
    expect(memberships.has('a')).toBe(false)
  })

  it('includes an order exactly two hours before the newest anchor', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T07:00:00.000Z'),
      order('b', '2026-08-31T09:00:00.000Z'),
    ])
    const group = memberships.get('a')?.operationGroup
    expect(group?.memberOrderIds).toEqual(['a', 'b'])
    expect(group?.isEligible).toBe(true)
    expect(group?.eligibleAt).toBe(group?.lastCreatedAt)
  })

  it('does not bridge separate rolling windows', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T07:00:00.000Z'),
      order('b', '2026-08-31T09:01:00.000Z'),
      order('c', '2026-08-31T11:00:00.000Z'),
    ])
    const groups = groupsOf(memberships)
    expect(groups).toHaveLength(1)
    expect(groups[0].memberOrderIds).toEqual(['b', 'c'])
    expect(memberships.has('a')).toBe(false)
  })

  it('keeps store, supplier, and expected date boundaries', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T09:00:00.000Z'),
      order('b', '2026-08-31T09:30:00.000Z', '2026-08-31T09:30:00.000Z', { storeId: 'store-2' }),
      order('c', '2026-08-31T09:40:00.000Z', '2026-08-31T09:40:00.000Z', { supplierId: 'warehouse-2' }),
      order('d', '2026-08-31T09:50:00.000Z', '2026-08-31T09:50:00.000Z', { expectedDate: '2026-09-02T00:00:00.000Z' }),
    ])
    expect(memberships.size).toBe(0)
  })

  it('leaves operated orders and singleton pending orders out of groups', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T07:00:00.000Z'),
      order('b', '2026-08-31T07:30:00.000Z', '2026-08-31T07:30:00.000Z', { status: 'CONFIRMED' }),
      order('c', '2026-08-31T08:00:00.000Z'),
    ])
    expect(memberships.size).toBe(0)
  })

  it('does not delay a group for two hours of inactivity', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T10:00:00.000Z'),
      order('b', '2026-08-31T10:30:00.000Z'),
    ], new Date('2026-08-31T10:31:00.000Z'))
    const group = memberships.get('a')?.operationGroup!
    expect(group.isEligible).toBe(true)
    expect(new Date(group.eligibleAt).getTime()).toBe(new Date(group.lastCreatedAt).getTime())
    expect(OPERATION_GROUP_WINDOW_MS).toBe(2 * 60 * 60 * 1000)
    expect(OPERATION_GROUP_IDLE_MS).toBe(0)
  })

  it('marks a group member with a pending revision as blocked without changing grouping', () => {
    const memberships = buildOperationGroups([
      order('a', '2026-08-31T07:00:00.000Z', '2026-08-31T07:00:00.000Z', { hasPendingRevision: true }),
      order('b', '2026-08-31T07:20:00.000Z'),
    ])
    expect(memberships.get('a')?.operationGroup?.blockedOrderIds).toEqual(['a'])
    expect(memberships.get('b')?.operationGroup?.blockedOrderIds).toEqual(['a'])
  })
})
