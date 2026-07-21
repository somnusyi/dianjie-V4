import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { consumptionRoutes } from '../../src/routes/consumption'

const suffix = `consumption-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const DAY = '2026-07-10'
const MONTH = '2026-07'

let app: ReturnType<typeof Fastify>
let tenantId = ''
let otherTenantId = ''
let storeId = ''
let otherStoreId = ''
let otherTenantStoreId = ''
let managerId = ''
let productAId = ''
let productBId = ''

type TestUser = { tenantId: string; storeId: string | null; userId: string; role: string }

async function seedConsumption(data: {
  tenantId: string; storeId: string; productId: string; dishId?: string; date: string
  invQty: string; cost: string; sourceType?: string; sourceId: string; createdById: string
}) {
  await prisma.stockConsumption.create({
    data: {
      tenantId: data.tenantId, storeId: data.storeId, productId: data.productId,
      dishId: data.dishId ?? null,
      date: new Date(`${data.date}T00:00:00.000Z`),
      quantity: data.invQty, inventoryQuantity: data.invQty,
      costAmountSnapshot: data.cost,
      sourceType: data.sourceType ?? 'dish_sale', sourceId: data.sourceId,
      createdById: data.createdById,
    },
  })
}

describe('store consumption view (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } })
    tenantId = tenant.id
    const otherTenant = await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })
    otherTenantId = otherTenant.id

    const store = await prisma.store.create({ data: { tenantId, no: `CS-${suffix}`, name: '消耗验证门店' } })
    storeId = store.id
    const otherStore = await prisma.store.create({ data: { tenantId, no: `CS2-${suffix}`, name: '同租户第二店' } })
    otherStoreId = otherStore.id
    const otherTenantStore = await prisma.store.create({ data: { tenantId: otherTenantId, no: `CS3-${suffix}`, name: '异租户门店' } })
    otherTenantStoreId = otherTenantStore.id

    const manager = await prisma.user.create({
      data: { tenantId, storeId, storeIds: [storeId], name: '消耗验证店长', email: `${suffix}-m@local.test`, password: 'test', role: 'MANAGER' },
    })
    managerId = manager.id
    const chef = await prisma.user.create({
      data: { tenantId, storeId: otherStoreId, storeIds: [otherStoreId], name: '二店厨师长', email: `${suffix}-c@local.test`, password: 'test', role: 'KITCHEN_LEAD' },
    })
    const admin = await prisma.user.create({
      data: { tenantId, name: '租户管理员', email: `${suffix}-a@local.test`, password: 'test', role: 'ADMIN' },
    })

    const productA = await prisma.product.create({
      data: { tenantId, code: 'MR001', name: '牛腩', category: '肉类', unit: 'kg', inventoryUnit: 'kg', price: 20 },
    })
    productAId = productA.id
    const productB = await prisma.product.create({
      data: { tenantId, code: 'MR002', name: '土豆', category: '蔬菜', unit: '斤', inventoryUnit: 'kg', price: 3 },
    })
    productBId = productB.id

    const dish1 = await prisma.dish.create({
      data: { tenantId, name: '土豆牛腩', salePrice: 68 },
    })
    const dish2 = await prisma.dish.create({
      data: { tenantId, name: '清炒土豆丝', salePrice: 22 },
    })

    const base = { tenantId, storeId, createdById: managerId }
    // 当日: pA 牛腩 菜品扣减 (dish1 两行 + dish2 一行)
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: DAY, invQty: '2', cost: '40', sourceId: 'sale-1' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: DAY, invQty: '1', cost: '20', sourceId: 'sale-2' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish2.id, date: DAY, invQty: '1', cost: '20', sourceId: 'sale-3' })
    // 当日: pB 土豆 人工报损
    await seedConsumption({ ...base, productId: productBId, date: DAY, invQty: '5', cost: '15', sourceType: 'manual', sourceId: 'manual-1' })
    // pA 前 7 日历史 (07-09: 2, 07-07: 4) → 日均 (2+4)/2 = 3
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: '2026-07-09', invQty: '2', cost: '40', sourceId: 'sale-4' })
    await seedConsumption({ ...base, productId: productAId, dishId: dish1.id, date: '2026-07-07', invQty: '4', cost: '80', sourceId: 'sale-5' })
    // 同月另一天, 供月汇总 daysWithData=2
    await seedConsumption({ ...base, productId: productBId, date: '2026-07-15', invQty: '1', cost: '3', sourceType: 'manual', sourceId: 'manual-2' })
    // 同租户另一门店同日的数据不应混入
    await seedConsumption({ ...base, storeId: otherStoreId, productId: productAId, dishId: dish1.id, date: DAY, invQty: '99', cost: '1980', sourceId: 'sale-other-store' })

    const users: Record<string, TestUser> = {
      manager: { tenantId, storeId, userId: managerId, role: 'MANAGER' },
      chef: { tenantId, storeId: otherStoreId, userId: chef.id, role: 'KITCHEN_LEAD' },
      admin: { tenantId, storeId: null, userId: admin.id, role: 'ADMIN' },
      waiter: { tenantId, storeId, userId: managerId, role: 'WAITER' },
    }

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const key = (request.headers['x-test-user'] as string) || 'manager'
      request.user = users[key]
    })
    await app.register(consumptionRoutes, { prefix: '/api/stores' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.stockConsumption.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.dish.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.store.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
  })

  it('aggregates the day by product with prev-7-day average comparison', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.totalCost).toBe(95)
    expect(body.items).toHaveLength(2)
    // 按 cost 降序: 牛腩 80 在前
    const [beef, potato] = body.items
    expect(beef).toMatchObject({
      productId: productAId, code: 'MR001', name: '牛腩', unit: 'kg',
      qty: 4, cost: 80, dishCount: 2, prev7AvgQty: 3, changePct: 33.3,
    })
    expect(potato).toMatchObject({
      productId: productBId, code: 'MR002', name: '土豆', unit: 'kg',
      qty: 5, cost: 15, dishCount: 0,
    })
    expect(potato.prev7AvgQty).toBeNull()
    expect(potato.changePct).toBeNull()
  })

  it('returns an empty list for a day without consumption data', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=2026-07-20` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ date: '2026-07-20', totalCost: 0, items: [] })
  })

  it('rejects malformed dates with 400', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=2026-7-1` })
    expect(response.statusCode).toBe(400)
  })

  it('groups the product detail by dish and flags manual loss rows', async () => {
    const beef = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily/${productAId}?date=${DAY}` })
    expect(beef.statusCode).toBe(200)
    const beefBody = beef.json()
    expect(beefBody.product).toMatchObject({ id: productAId, name: '牛腩', unit: 'kg' })
    expect(beefBody.rows).toEqual([
      expect.objectContaining({ dishName: '土豆牛腩', manual: false, qty: 3, cost: 60 }),
      expect.objectContaining({ dishName: '清炒土豆丝', manual: false, qty: 1, cost: 20 }),
    ])

    const potato = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/daily/${productBId}?date=${DAY}` })
    expect(potato.statusCode).toBe(200)
    expect(potato.json().rows).toEqual([
      expect.objectContaining({ dishId: null, dishName: null, manual: true, qty: 5, cost: 15 }),
    ])
  })

  it('summarizes the month with total cost, data days and top products', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/summary?month=${MONTH}` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    // 有数据天: 07-07 / 07-09 / 07-10 / 07-15
    expect(body.daysWithData).toBe(4)
    // 80+15 (07-10) + 40 (07-09) + 80 (07-07) + 3 (07-15)
    expect(body.totalCost).toBe(218)
    expect(body.top).toHaveLength(2)
    expect(body.top[0]).toMatchObject({ productId: productAId, name: '牛腩', qty: 10, cost: 200 })
    expect(body.top[1]).toMatchObject({ productId: productBId, name: '土豆', qty: 6, cost: 18 })
  })

  it('returns an empty month summary without data', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/stores/${storeId}/consumption/summary?month=2026-08` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ month: '2026-08', totalCost: 0, daysWithData: 0, top: [] })
  })

  it('blocks store-scoped roles from other stores with 403', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${otherStoreId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'manager' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('hides other-tenant stores behind 404 for tenant-level roles', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${otherTenantStoreId}/consumption/summary?month=${MONTH}`,
      headers: { 'x-test-user': 'admin' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('rejects roles without consumption view permission', async () => {
    const response = await app.inject({
      method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'waiter' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('lets a chef see only their own store', async () => {
    const own = await app.inject({
      method: 'GET', url: `/api/stores/${otherStoreId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'chef' },
    })
    expect(own.statusCode).toBe(200)
    expect(own.json().items[0]).toMatchObject({ productId: productAId, qty: 99 })

    const cross = await app.inject({
      method: 'GET', url: `/api/stores/${storeId}/consumption/daily?date=${DAY}`,
      headers: { 'x-test-user': 'chef' },
    })
    expect(cross.statusCode).toBe(403)
  })
})
