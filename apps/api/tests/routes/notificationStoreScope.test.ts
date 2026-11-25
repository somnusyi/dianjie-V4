import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(),
}))

vi.mock('@dianjie/db', () => ({
  prisma: { notification: mocks },
}))

import { notificationRoutes } from '../../src/routes/notifications'

async function requestAs(role: string, method: 'GET' | 'PATCH', url: string) {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: 't1', userId: 'u1', role } })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  try { return await app.inject({ method, url }) }
  finally { await app.close() }
}

describe('store notification isolation', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(0)
    mocks.updateMany.mockResolvedValue({ count: 1 })
  })

  it('uses only personal notifications for all store read and read-state routes', async () => {
    await requestAs('MANAGER', 'GET', '/notifications')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 't1', recipientId: 'u1' },
    }))
    await requestAs('MANAGER', 'GET', '/notifications/unread-count')
    expect(mocks.count).toHaveBeenCalledWith({ where: { tenantId: 't1', recipientId: 'u1', read: false } })
    await requestAs('MANAGER', 'PATCH', '/notifications/n1/read')
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', tenantId: 't1', recipientId: 'u1' }, data: { read: true },
    })
    await requestAs('MANAGER', 'PATCH', '/notifications/read-all')
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { tenantId: 't1', recipientId: 'u1', read: false }, data: { read: true },
    })
  })

  it('keeps tenant-wide broadcasts for group roles', async () => {
    await requestAs('SUPPLY_CHAIN', 'GET', '/notifications')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 't1', OR: [{ recipientId: 'u1' }, { recipientId: null, recipientRole: 'SUPPLY_CHAIN' }] },
    }))
  })
})
