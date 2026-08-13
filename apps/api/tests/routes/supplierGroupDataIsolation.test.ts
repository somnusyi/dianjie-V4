import { beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * 2026-08 发现:/api/dashboard、/api/revenue、/api/profit 三条老路由只用
 * isStoreScoped 兜权限，而供应商不是门店范围角色 → 过滤器为空 → 供应商账号
 * 能读到全租户的营业额、利润表、采购总额和付给别家供应商的应付明细。
 *
 * 这里锁住修复:供应商角色在进入任何 handler 之前就被 403。
 * 守卫挂在 preHandler 上，所以 prisma 只要能被 import 即可，不会真的被调用。
 */
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }) }
})

import { dashboardRoutes } from '../../src/routes/dashboard'
import { revenueRoutes } from '../../src/routes/revenue'
import { profitRoutes } from '../../src/routes/profit'

const SUPPLIER_ROLES = ['SUPPLIER_OWNER', 'SUPPLIER_STAFF']
const GROUP_ENDPOINTS = [
  '/api/dashboard/stats',
  '/api/dashboard/purchase-trend',
  '/api/revenue',
  '/api/revenue/summary',
  '/api/profit/group/snapshot',
  '/api/profit/store/store-1',
  '/api/profit/store/store-1/snapshot',
  '/api/profit/store/store-1/closed-months',
]

function build(role: string) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role,
      supplierId: role.startsWith('SUPPLIER') ? 'SUP001' : null,
      storeId: null,
    }
  })
  return app
}

async function register(app: any) {
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
  await app.register(revenueRoutes, { prefix: '/api/revenue' })
  await app.register(profitRoutes, { prefix: '/api/profit' })
  await app.ready()
}

describe('集团经营数据对外部供应商隔离', () => {
  const apps: Record<string, any> = {}

  beforeAll(async () => {
    for (const role of [...SUPPLIER_ROLES, 'ADMIN']) {
      apps[role] = build(role)
      await register(apps[role])
    }
  })

  for (const role of SUPPLIER_ROLES) {
    for (const url of GROUP_ENDPOINTS) {
      it(`${role} 读 ${url} → 403`, async () => {
        const response = await apps[role].inject({ method: 'GET', url })
        expect(response.statusCode).toBe(403)
        expect(response.json().error).toContain('无权访问集团经营数据')
      })
    }
  }

  it('写入口同样拦住供应商', async () => {
    const response = await apps.SUPPLIER_OWNER.inject({
      method: 'POST', url: '/api/revenue', payload: { date: '2026-08-01', amount: 1 },
    })
    expect(response.statusCode).toBe(403)
  })

  it('非供应商角色不被这道守卫拦(拿不到 403)', async () => {
    const response = await apps.ADMIN.inject({ method: 'GET', url: '/api/revenue' })
    expect(response.statusCode).not.toBe(403)
  })
})
