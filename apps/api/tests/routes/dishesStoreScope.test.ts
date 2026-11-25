import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dishFindMany: vi.fn(),
  dishFindFirst: vi.fn(),
  saleFindMany: vi.fn(),
  saleGroupBy: vi.fn(),
  taskFindMany: vi.fn(),
  consumptionFindMany: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      dish: { findMany: mocks.dishFindMany, findFirst: mocks.dishFindFirst },
      dishSale: { findMany: mocks.saleFindMany, groupBy: mocks.saleGroupBy },
      deferredBomTask: { findMany: mocks.taskFindMany },
      stockConsumption: { findMany: mocks.consumptionFindMany },
    },
  }
})

import { dishRoutes } from '../../src/routes/dishes'

const manager = { tenantId: 'tenant-a', userId: 'manager-a', role: 'MANAGER', storeId: 'store-a', storeIds: ['store-a', 'store-c'] }

async function requestAs(user: Record<string, unknown>, url: string) {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  await app.register(dishRoutes, { prefix: '/api/dishes' })
  try { return await app.inject({ method: 'GET', url }) }
  finally { await app.close() }
}

describe('dish reads follow store assignment', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.dishFindMany.mockResolvedValue([])
    mocks.dishFindFirst.mockResolvedValue(null)
    mocks.saleFindMany.mockResolvedValue([])
    mocks.saleGroupBy.mockResolvedValue([])
    mocks.taskFindMany.mockResolvedValue([])
    mocks.consumptionFindMany.mockResolvedValue([])
  })

  it('limits the menu and BOM coverage to the assigned stores', async () => {
    expect((await requestAs(manager, '/api/dishes?withCost=1')).statusCode).toBe(200)
    expect(mocks.dishFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-a', storeIds: { hasSome: ['store-a', 'store-c'] } },
    }))

    expect((await requestAs(manager, '/api/dishes/bom-coverage?days=30')).statusCode).toBe(200)
    expect(mocks.saleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-a', storeId: { in: ['store-a', 'store-c'] } }),
    }))
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-a', storeId: { in: ['store-a', 'store-c'] } }),
    }))
    expect(mocks.dishFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-a', storeIds: { hasSome: ['store-a', 'store-c'] } },
    }))
  })

  it('hides another store’s dish detail, recipes, and BOM versions', async () => {
    for (const path of ['/api/dishes/dish-b', '/api/dishes/dish-b/recipes', '/api/dishes/dish-b/bom-versions']) {
      expect((await requestAs(manager, path)).statusCode).toBe(404)
      expect(mocks.dishFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { id: 'dish-b', tenantId: 'tenant-a', storeIds: { hasSome: ['store-a', 'store-c'] } },
      }))
    }
  })

  it('keeps sales reads within all assigned stores and rejects another store', async () => {
    expect((await requestAs(manager, '/api/dishes/sales')).statusCode).toBe(200)
    expect(mocks.saleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-a', storeId: { in: ['store-a', 'store-c'] } },
    }))
    expect((await requestAs(manager, '/api/dishes/sales?storeId=store-b')).statusCode).toBe(403)
    expect((await requestAs(manager, '/api/dishes/sales-rank')).statusCode).toBe(200)
    expect(mocks.saleGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ storeId: { in: ['store-a', 'store-c'] } }),
    }))
    expect((await requestAs(manager, '/api/dishes/projected-consumption')).statusCode).toBe(200)
    expect(mocks.consumptionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ storeId: { in: ['store-a', 'store-c'] } }),
    }))
  })

  it('preserves group access and closes unbound store accounts', async () => {
    expect((await requestAs({ tenantId: 'tenant-a', role: 'CHEF_DIRECTOR' }, '/api/dishes/bom-coverage')).statusCode).toBe(200)
    expect(mocks.saleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ storeId: expect.anything() }),
    }))
    expect((await requestAs({ tenantId: 'tenant-a', role: 'MANAGER', storeIds: [] }, '/api/dishes')).statusCode).toBe(200)
    expect(mocks.dishFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-a', id: { in: [] } },
    }))
  })
})
