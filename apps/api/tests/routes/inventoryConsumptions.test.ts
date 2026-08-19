import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { inventoryRoutes } from '../../src/routes/inventory'

function makeUser(overrides: Record<string, any> = {}) {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    role: 'ADMIN',
    storeId: null,
    ...overrides,
  }
}

function buildApp(user: Record<string, any>) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = user
  })
  return app.register(inventoryRoutes, { prefix: '/api/inventory' })
}

const fakeRow = (overrides: Record<string, any> = {}) => ({
  id: 'c-1',
  tenantId: 'tenant-a',
  storeId: 'store-1',
  productId: 'prod-1',
  date: new Date('2026-07-10T00:00:00.000Z'),
  quantity: 1,
  note: null,
  sourceType: 'manual',
  sourceId: 'op-1',
  createdById: 'user-a',
  createdAt: new Date('2026-07-10T08:00:00.000Z'),
  voidedAt: null,
  product: { name: '牛腩', unit: 'kg', spec: null, code: 'MR001' },
  createdBy: { name: '店长' },
  ...overrides,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/inventory/consumptions — legacy mode', () => {
  it('returns an array when no pagination params are sent', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const rows = [fakeRow(), fakeRow({ id: 'c-2' })]
    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue(rows as any)

    const res = await app.inject({ method: 'GET', url: '/api/inventory/consumptions' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
  })

  it('passes take=100 and a date gte filter in legacy mode', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const findManySpy = vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])

    const res = await app.inject({ method: 'GET', url: '/api/inventory/consumptions?days=7' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const callArgs = findManySpy.mock.calls[0]?.[0] as any
    expect(callArgs.take).toBe(100)
    expect(callArgs.where.date.gte).toBeInstanceOf(Date)
    expect(callArgs.where.voidedAt).toBeNull()
    expect(callArgs.where.tenantId).toBe('tenant-a')
  })
})

describe('GET /api/inventory/consumptions — pagination mode', () => {
  it('returns {items, total, page, pageSize} when page and pageSize are provided', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const rows = [fakeRow(), fakeRow({ id: 'c-2' })]
    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue(rows as any)
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(25)

    const res = await app.inject({ method: 'GET', url: '/api/inventory/consumptions?page=2&pageSize=10' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ total: 25, page: 2, pageSize: 10 })
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items).toHaveLength(2)
  })

  it('computes skip correctly from page and pageSize', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    const res = await app.inject({ method: 'GET', url: '/api/inventory/consumptions?page=3&pageSize=20' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.skip).toBe(40)
    expect(callArgs.take).toBe(20)
  })

  it('uses the same where for findMany and count', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue({ id: 'store-1' } as any)
    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=store-1&startDate=2026-07-01&endDate=2026-07-15&q=牛腩',
    })
    await app.close()

    const findManyArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    const countArgs = vi.mocked(prisma.stockConsumption.count).mock.calls[0]?.[0] as any
    expect(findManyArgs.where).toEqual(countArgs.where)
  })
})

describe('GET /api/inventory/consumptions — date filtering', () => {
  it('applies startDate and endDate as date gte/lte', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&startDate=2026-07-01&endDate=2026-07-15',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.date.gte).toEqual(new Date('2026-07-01T00:00:00.000Z'))
    expect(callArgs.where.date.lte).toEqual(new Date('2026-07-15T00:00:00.000Z'))
  })

  it('applies only startDate when endDate is omitted', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&startDate=2026-07-01',
    })
    await app.close()

    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.date.gte).toEqual(new Date('2026-07-01T00:00:00.000Z'))
    expect(callArgs.where.date.lte).toBeUndefined()
  })

  it('rejects startDate after endDate with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&startDate=2026-07-20&endDate=2026-07-15',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('rejects invalid date format with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&startDate=2026/07/01',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('rejects impossible calendar date with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&startDate=2026-02-29',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/inventory/consumptions — product search (q)', () => {
  it('adds product name/code filter when q is provided', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&q=牛腩',
    })
    await app.close()

    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.AND).toBeDefined()
    expect(callArgs.where.AND).toHaveLength(1)
    const productFilter = callArgs.where.AND[0].product
    expect(productFilter.OR).toEqual([
      { name: { contains: '牛腩', mode: 'insensitive' } },
      { code: { contains: '牛腩', mode: 'insensitive' } },
    ])
  })

  it('splits multi-term q into separate AND conditions', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&q=牛腩 MR001',
    })
    await app.close()

    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.AND).toHaveLength(2)
  })
})

describe('GET /api/inventory/consumptions — store scoping & permissions', () => {
  it('resolves storeId from query for ADMIN role', async () => {
    const user = makeUser({ role: 'ADMIN' })
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue({ id: 'store-1' } as any)
    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=store-1',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.storeId).toBe('store-1')
  })

  it('returns 404 when storeId does not belong to tenant', async () => {
    const user = makeUser({ role: 'ADMIN' })
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=other-tenant-store',
    })
    await app.close()

    expect(res.statusCode).toBe(404)
  })

  it('rejects out-of-scope storeId for store-scoped MANAGER (403)', async () => {
    const user = makeUser({ role: 'MANAGER', storeId: 'my-store' })
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=other-store',
    })
    await app.close()

    expect(res.statusCode).toBe(403)
  })

  it('defaults store-scoped MANAGER to their bound store; multi-store can pick in-scope store', async () => {
    const user = makeUser({ role: 'MANAGER', storeId: 'my-store', storeIds: ['my-store', 'second-store'] })
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    // 未指定门店 → 默认集合第一家
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10',
    })
    expect(res1.statusCode).toBe(200)
    let callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.storeId).toBe('my-store')

    // 指定集合内第二家店 → 放行并收窄
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=second-store',
    })
    await app.close()
    expect(res2.statusCode).toBe(200)
    callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[1]?.[0] as any
    expect(callArgs.where.storeId).toBe('second-store')
  })

  it('returns 400 when store-scoped role has no bound store', async () => {
    const user = makeUser({ role: 'MANAGER', storeId: null })
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('allows SUPPLY_CHAIN role to select any tenant store', async () => {
    const user = makeUser({ role: 'SUPPLY_CHAIN' })
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue({ id: 'store-x' } as any)
    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10&storeId=store-x',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.where.storeId).toBe('store-x')
  })

  it('rejects supplier roles with 403', async () => {
    const user = makeUser({ role: 'SUPPLIER_OWNER' })
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10',
    })
    await app.close()

    expect(res.statusCode).toBe(403)
  })

  it('rejects unauthorized roles with 403', async () => {
    const user = makeUser({ role: 'WAITER' })
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10',
    })
    await app.close()

    expect(res.statusCode).toBe(403)
  })
})

describe('GET /api/inventory/consumptions — stable sort', () => {
  it('orders by date desc, createdAt desc, id desc', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=10',
    })
    await app.close()

    const callArgs = vi.mocked(prisma.stockConsumption.findMany).mock.calls[0]?.[0] as any
    expect(callArgs.orderBy).toEqual([
      { date: 'desc' },
      { createdAt: 'desc' },
      { id: 'desc' },
    ])
  })
})

describe('GET /api/inventory/consumptions — validation', () => {
  it('rejects page without pageSize with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('rejects pageSize without page with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?pageSize=10',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('rejects pageSize > 100 with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=200',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('rejects an excessively large page with 400', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1000001&pageSize=10',
    })
    await app.close()

    expect(res.statusCode).toBe(400)
  })

  it('accepts pageSize = 100', async () => {
    const user = makeUser()
    const app = buildApp(user)
    await app.ready()

    vi.spyOn(prisma.stockConsumption, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/inventory/consumptions?page=1&pageSize=100',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
  })
})
