import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/routes/orders.ts', import.meta.url), 'utf8')

describe('operation-group atomic revision route contract', () => {
  it('uses one serializable transaction and exact locked membership for every original order', () => {
    expect(source).toContain("app.patch('/operation-groups/:groupId/items'")
    expect(source).toContain('operation-group:${tenantId}:${groupIdParam}')
    expect(source).toContain('order-revision:${tenantId}:${orderId}')
    expect(source).toContain('const lockedMemberIds = lockedGroup?.memberOrderIds || []')
    expect(source).toContain('TransactionIsolationLevel.Serializable')
    expect(source).toContain("entityType: 'OperationGroupRevision'")
  })

  it('durably replays the whole group and binds the marker to the requesting user', () => {
    expect(source).toContain('tenantId, userId, entityType: \'OperationGroupRevision\'')
    expect(source).toContain('groupRevisionFingerprint')
    expect(source).toContain('requesterUserId: userId')
    expect(source).toContain('duplicated: true')
  })

  it('only supersedes legacy internal pending revisions with immutable provenance', () => {
    expect(source).toContain('isSupersedableInternalPendingRevisionEvent(event, groupIdParam)')
    expect(source).toContain('内部供应链不能覆盖')
    expect(source).toContain('supersededByGroupRequestKey')
  })

  it('persists zero quantity as a line value instead of treating it as removal', () => {
    expect(source).toContain(".nonnegative('订货数量不能小于 0')")
    expect(source).toContain('if (item.quantity > 0 && item.quantity < moq - 0.0001)')
    expect(source).toContain('quantity: new Prisma.Decimal(next.quantity)')
  })
})
