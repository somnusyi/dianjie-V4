import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * 2026-08 评审发现：/api/meituan/* 全部端点无租户/门店过滤，且 allowedRoles
 * 把门店级 MANAGER 放进集团只读角色 → 任一店长可读全集团订单流水；
 * /orders/:mtOrderId 为纯 IDOR。
 *
 * 这里锁住修复：MtOrder 无 tenantId 列，租户边界经由 storeId → Store.tenantId
 * 收敛 —— 门店角色只看本店（fail-closed），集团角色看租户门店集合，
 * storeId 为 null 的未映射历史订单仅 SUPER_ADMIN/ADMIN 可见。
 */
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      store: { findMany: vi.fn() },
      mtOrder: {
        findMany: vi.fn(),
        count: vi.fn(),
        aggregate: vi.fn(),
        groupBy: vi.fn(),
        findUnique: vi.fn(),
      },
    } as any,
  }
})

import { prisma } from '@dianjie/db'
import { meituanDataRoutes } from '../../src/routes/meituanData'
import { businessDateKey } from '../../src/lib/businessTime'

const storeFindMany = (prisma as any).store.findMany as ReturnType<typeof vi.fn>
const mtOrderFindMany = (prisma as any).mtOrder.findMany as ReturnType<typeof vi.fn>
const mtOrderAggregate = (prisma as any).mtOrder.aggregate as ReturnType<typeof vi.fn>
const mtOrderFindUnique = (prisma as any).mtOrder.findUnique as ReturnType<typeof vi.fn>

const USER = {
  managerStore1: { tenantId: 'tenant-1', userId: 'u1', role: 'MANAGER', storeId: 'store-1', supplierId: null },
  managerUnbound: { tenantId: 'tenant-1', userId: 'u2', role: 'MANAGER', storeId: null, supplierId: null },
  finance: { tenantId: 'tenant-1', userId: 'u3', role: 'FINANCE', storeId: null, supplierId: null },
  superAdmin: { tenantId: 'tenant-1', userId: 'u4', role: 'SUPER_ADMIN', storeId: null, supplierId: null },
  kitchenLead: { tenantId: 'tenant-1', userId: 'u5', role: 'KITCHEN_LEAD', storeId: 'store-1', supplierId: null },
}

async function makeApp(user: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = user })
  await app.register(meituanDataRoutes, { prefix: '/api/meituan' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  storeFindMany.mockResolvedValue([{ id: 'store-1' }, { id: 'store-2' }])
  mtOrderFindMany.mockResolvedValue([])
  ;(prisma as any).mtOrder.count.mockResolvedValue(0)
  mtOrderAggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: {} })
  ;(prisma as any).mtOrder.groupBy.mockResolvedValue([])
  mtOrderFindUnique.mockResolvedValue(null)
})

describe('美团数据租户/门店隔离', () => {
  it('非白名单角色（KITCHEN_LEAD）→ 403', async () => {
    const app = await makeApp(USER.kitchenLead)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    expect(response.statusCode).toBe(403)
  })

  it('MANAGER 列表只查本店', async () => {
    const app = await makeApp(USER.managerStore1)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    expect(response.statusCode).toBe(200)
    const where = mtOrderFindMany.mock.calls[0][0].where
    expect(where.storeId).toEqual({ in: ['store-1'] })
  })

  it('MANAGER 读他店订单详情 → 404（防 IDOR）', async () => {
    mtOrderFindUnique.mockResolvedValueOnce({
      mtOrderId: 'MT-OTHER', storeId: 'store-2', items: [], payments: [], refundOrders: [],
    })
    const app = await makeApp(USER.managerStore1)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders/MT-OTHER' })
    expect(response.statusCode).toBe(404)
  })

  it('MANAGER 可读本店订单详情', async () => {
    mtOrderFindUnique.mockResolvedValueOnce({
      mtOrderId: 'MT-OWN', storeId: 'store-1', items: [], payments: [], refundOrders: [],
    })
    const app = await makeApp(USER.managerStore1)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders/MT-OWN' })
    expect(response.statusCode).toBe(200)
    expect(response.json().storeId).toBe('store-1')
  })

  it('MANAGER 未绑定门店 → 查询空门店集合（fail-closed）', async () => {
    const app = await makeApp(USER.managerUnbound)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    expect(response.statusCode).toBe(200)
    const where = mtOrderFindMany.mock.calls[0][0].where
    expect(where.storeId).toEqual({ in: [] })
  })

  it('MANAGER 绑定的门店不在本租户 → 查询空门店集合', async () => {
    const app = await makeApp({ ...USER.managerStore1, storeId: 'store-other-tenant' })
    await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    const where = mtOrderFindMany.mock.calls[0][0].where
    expect(where.storeId).toEqual({ in: [] })
  })

  it('FINANCE 查租户全部已映射门店、不含未映射订单', async () => {
    const app = await makeApp(USER.finance)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    expect(response.statusCode).toBe(200)
    const where = mtOrderFindMany.mock.calls[0][0].where
    expect(where.storeId).toEqual({ in: ['store-1', 'store-2'] })
    expect(where.OR).toBeUndefined()
  })

  it('SUPER_ADMIN 可见未映射（storeId=null）历史订单', async () => {
    const app = await makeApp(USER.superAdmin)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/orders' })
    expect(response.statusCode).toBe(200)
    const where = mtOrderFindMany.mock.calls[0][0].where
    expect(where.OR).toEqual([
      { storeId: { in: ['store-1', 'store-2'] } },
      { storeId: null },
    ])
  })

  it('stats/today 的"今天"按业务时区（上海）切日', async () => {
    const app = await makeApp(USER.finance)
    const response = await app.inject({ method: 'GET', url: '/api/meituan/stats/today' })
    expect(response.statusCode).toBe(200)
    const where = mtOrderAggregate.mock.calls[0][0].where
    expect(where.businessTime.getTime()).toBe(new Date(`${businessDateKey()}T00:00:00.000Z`).getTime())
    expect(response.json().date).toBe(businessDateKey())
  })
})
