import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  receipt: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  paymentSchedule: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  lossClaim: { count: vi.fn() },
  product: { findMany: vi.fn() },
  store: { findMany: vi.fn() },
}))
vi.mock('@dianjie/db', () => ({ prisma: db }))
vi.mock('../../src/lib/cache', () => ({ cached: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load() }))

import { dashboardRoutes } from '../../src/routes/dashboard'

function appFor(role: string, storeIds: string[] = []) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = { tenantId: 'tenant-a', role, userId: 'user-a', storeIds, storeId: storeIds[0] ?? null }
  })
  return app
}

describe('首页统计按门店范围读取', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.receipt.aggregate.mockResolvedValue({ _sum: { totalAmount: 10 } })
    db.receipt.count.mockResolvedValue(1)
    db.receipt.findMany.mockResolvedValue([])
    db.receipt.groupBy.mockResolvedValue([{ storeId: 'other-store', _sum: { totalAmount: 99 }, _count: { id: 1 } }])
    db.paymentSchedule.aggregate.mockResolvedValue({ _sum: { amount: 0 } })
    db.paymentSchedule.count.mockResolvedValue(1)
    db.paymentSchedule.findMany.mockResolvedValue([])
    db.lossClaim.count.mockResolvedValue(2)
    db.product.findMany.mockResolvedValue([{ id: 'global-product', stock: 0, minStock: 1 }])
    db.store.findMany.mockResolvedValue([{ id: 'other-store', name: '其他店', no: 'X' }])
  })

  for (const role of ['MANAGER', 'SUPERVISOR', 'PURCHASER', 'REGIONAL_MANAGER', 'STAFF']) {
    it(`${role} 只看到绑定门店的统计`, async () => {
      const app = appFor(role, ['mine'])
      await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
      const response = await app.inject({ method: 'GET', url: '/api/dashboard/stats' })
      expect(response.statusCode).toBe(200)
      const data = response.json()
      expect(data.pendingApprovalCount).toBe(0)
      expect(data.storeBreakdown).toEqual([])
      expect(data.lowStockProducts).toEqual([])
      expect(db.receipt.groupBy).not.toHaveBeenCalled()
      expect(db.product.findMany).not.toHaveBeenCalled()
      expect(db.lossClaim.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', status: 'PENDING', storeId: { in: ['mine'] } } })
      await app.close()
    })
  }

  it('集团角色保留跨店汇总', async () => {
    const app = appFor('ADMIN')
    await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
    const response = await app.inject({ method: 'GET', url: '/api/dashboard/stats' })
    expect(response.statusCode).toBe(200)
    expect(response.json().storeBreakdown).toHaveLength(1)
    expect(db.receipt.groupBy).toHaveBeenCalledOnce()
    expect(db.lossClaim.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', status: 'PENDING' } })
    await app.close()
  })
})
