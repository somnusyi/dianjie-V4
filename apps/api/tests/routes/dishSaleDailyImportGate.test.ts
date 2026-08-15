import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * 2026-08 评审发现的双重扣减漏洞：
 *   - POST /api/dishes/sales 写 source='manual' 的 DishSale + dish_sale 消耗；
 *   - 日报确认只清 source='daily_pos_upload' 的销量后重建；
 *   - 两侧互不感知 → 同日同菜：手工 N 份 + 日报 N 份 = BOM 消耗扣 2N、销量榜双计。
 *
 * 这里锁住双向闸门：任一侧发现对方已存在即 409；不静默删除手工数据。
 * 解除冲突的唯一入口：DELETE /api/dishes/sales/:id（同事务删销量与消耗）。
 */
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      $transaction: vi.fn(),
      store: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
      dish: { findFirst: vi.fn() },
      dailyBusinessImport: { findFirst: vi.fn() },
      dishSale: { findFirst: vi.fn(), delete: vi.fn() },
      stockConsumption: { deleteMany: vi.fn() },
    } as any,
  }
})

import { prisma } from '@dianjie/db'
import { dishRoutes } from '../../src/routes/dishes'
import { assertNoManualDishSales } from '../../src/routes/dailyBusinessImports'

const P = prisma as any
const USER = {
  manager: { tenantId: 'tenant-1', userId: 'u1', role: 'MANAGER', storeId: 'store-1', supplierId: null },
  staff: { tenantId: 'tenant-1', userId: 'u2', role: 'STAFF', storeId: 'store-1', supplierId: null },
}

async function makeApp(user: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = user })
  await app.register(dishRoutes, { prefix: '/api/dishes' })
  await app.ready()
  return app
}

const SALE_BODY = {
  storeId: 'store-1', dishId: 'dish-1', date: '2026-08-10',
  quantity: 10, grossAmount: 200,
}

/** POST /sales 事务的 tx 形状（advisory lock + upsert + 消耗重建）。 */
const txMock = {
  $executeRaw: vi.fn(),
  dishSale: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ id: 'sale-1', quantity: 10 }),
    delete: vi.fn().mockResolvedValue({ id: 'sale-1' }),
  },
  stockConsumption: { deleteMany: vi.fn(), createMany: vi.fn() },
}

beforeEach(() => {
  vi.clearAllMocks()
  P.$transaction.mockImplementation(async (fn: any) => fn(txMock))
  P.store.findFirst.mockResolvedValue({ id: 'store-1' })
  P.dish.findFirst.mockResolvedValue({ id: 'dish-1', inventoryPolicy: 'EXCLUDE', bomVersions: [] })
  P.dailyBusinessImport.findFirst.mockResolvedValue(null)
  P.dishSale.findFirst.mockResolvedValue(null)
  P.dishSale.delete.mockResolvedValue({ id: 'sale-1' })
  P.stockConsumption.deleteMany.mockResolvedValue({ count: 0 })
})

describe('手工销量与日报互斥（双扣闸门）', () => {
  it('该营业日已有 CONFIRMED 日报时，手工录入销量 → 409', async () => {
    P.dailyBusinessImport.findFirst.mockResolvedValue({ id: 'import-1' })
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'POST', url: '/api/dishes/sales', payload: SALE_BODY })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('已有确认的日报')
    expect(P.$transaction).not.toHaveBeenCalled()
  })

  it('无日报时手工录入正常写入', async () => {
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'POST', url: '/api/dishes/sales', payload: SALE_BODY })
    expect(response.statusCode).toBe(200)
    expect(P.dailyBusinessImport.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', storeId: 'store-1', businessDate: new Date('2026-08-10T00:00:00.000Z'), status: 'CONFIRMED' },
      select: { id: true },
    })
  })

  it('同日存在非日报来源的销量时，confirm 闸门抛 409 并列出冲突', async () => {
    const tx = {
      dishSale: {
        findMany: vi.fn().mockResolvedValue([
          { source: 'manual', quantity: 5, dish: { name: '黄粉皮' } },
          { source: 'manual', quantity: 2, dish: { name: '纯牛奶' } },
        ]),
      },
    }
    await expect(assertNoManualDishSales(tx as any, 'tenant-1', 'store-1', new Date('2026-08-10T00:00:00Z')))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(tx.dishSale.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', storeId: 'store-1', date: new Date('2026-08-10T00:00:00Z'), source: { not: 'daily_pos_upload' } },
      select: { source: true, quantity: true, dish: { select: { name: true } } },
      take: 51,
    })
    try {
      await assertNoManualDishSales(tx as any, 'tenant-1', 'store-1', new Date('2026-08-10T00:00:00Z'))
      expect.unreachable('should have thrown')
    } catch (error: any) {
      expect(error.message).toContain('manual')
      expect(error.message).toContain('黄粉皮')
      expect(error.message).toContain('重复扣减库存')
    }
  })

  it('同日只有日报来源的销量时，confirm 闸门放行', async () => {
    const tx = { dishSale: { findMany: vi.fn().mockResolvedValue([]) } }
    await expect(assertNoManualDishSales(tx as any, 'tenant-1', 'store-1', new Date('2026-08-10T00:00:00Z')))
      .resolves.toBeUndefined()
  })
})

describe('DELETE /api/dishes/sales/:id（解除冲突的删除入口）', () => {
  it('非录入角色（STAFF）→ 403', async () => {
    const app = await makeApp(USER.staff)
    const response = await app.inject({ method: 'DELETE', url: '/api/dishes/sales/sale-1' })
    expect(response.statusCode).toBe(403)
  })

  it('记录不存在 → 404', async () => {
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'DELETE', url: '/api/dishes/sales/sale-1' })
    expect(response.statusCode).toBe(404)
  })

  it('日报生成的销量不能直接删除 → 409', async () => {
    P.dishSale.findFirst.mockResolvedValue({
      id: 'sale-1', storeId: 'store-1', source: 'daily_pos_upload',
      date: new Date('2026-08-10T00:00:00Z'), dish: { name: '黄粉皮' },
    })
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'DELETE', url: '/api/dishes/sales/sale-1' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('日报更正')
  })

  it('门店角色不能删除他店记录 → 403', async () => {
    P.dishSale.findFirst.mockResolvedValue({
      id: 'sale-1', storeId: 'store-2', source: 'manual',
      date: new Date('2026-08-10T00:00:00Z'), dish: { name: '黄粉皮' },
    })
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'DELETE', url: '/api/dishes/sales/sale-1' })
    expect(response.statusCode).toBe(403)
    expect(P.$transaction).not.toHaveBeenCalled()
  })

  it('本店手工销量删除时，同事务清理 dish_sale 消耗', async () => {
    P.dishSale.findFirst.mockResolvedValue({
      id: 'sale-1', storeId: 'store-1', source: 'manual',
      date: new Date('2026-08-10T00:00:00Z'), dish: { name: '黄粉皮' },
    })
    const app = await makeApp(USER.manager)
    const response = await app.inject({ method: 'DELETE', url: '/api/dishes/sales/sale-1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(true)
    expect(txMock.stockConsumption.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', sourceType: 'dish_sale', sourceId: 'sale-1' },
    })
    expect(txMock.dishSale.delete).toHaveBeenCalledWith({ where: { id: 'sale-1' } })
  })
})
