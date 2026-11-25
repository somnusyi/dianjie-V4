import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(), notificationCreate: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: {
    user: { findMany: mocks.userFindMany },
    notification: { create: mocks.notificationCreate },
  } }
})

import { sendNotification } from '../../src/services/notification'

describe('store notification recipients', () => {
  beforeEach(() => {
    mocks.userFindMany.mockReset().mockResolvedValue([{ id: 'manager-a' }])
    mocks.notificationCreate.mockReset().mockResolvedValue({ id: 'n1' })
  })

  it('delivers only to active users whose effective store assignment contains the target store', async () => {
    await sendNotification({ tenantId: 't1', recipientRole: 'MANAGER', storeId: 'store-a', type: 'ORDER_CONFIRMED', title: '接单', body: 'test' })
    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { tenantId: 't1', role: 'MANAGER', status: 'ACTIVE', OR: [
        { storeIds: { has: 'store-a' } }, { storeIds: { isEmpty: true }, storeId: 'store-a' },
      ] },
      select: { id: true },
    })
    expect(mocks.notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: 't1', recipientRole: 'MANAGER', recipientId: 'manager-a', type: 'ORDER_CONFIRMED',
    }) })
  })

  it('refuses to create store-role broadcasts without a store', async () => {
    const result = await sendNotification({ tenantId: 't1', recipientRole: 'MANAGER', type: 'ORDER_CONFIRMED', title: '接单', body: 'test' })
    expect(result.skipped).toBe(true)
    expect(mocks.notificationCreate).not.toHaveBeenCalled()
  })
})
