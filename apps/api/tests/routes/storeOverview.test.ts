import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { storeOverviewRoutes } from '../../src/routes/storeOverview'
import { estimatedStoreInventory } from '../../src/services/storeInventory'

vi.mock('../../src/services/storeInventory', () => ({
  estimatedStoreInventory: vi.fn(),
}))

const mockEstimatedStoreInventory = vi.mocked(estimatedStoreInventory)

function makeActor(overrides: Record<string, any> = {}) {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    role: 'SUPPLY_CHAIN',
    storeId: null,
    supplierId: null,
    ...overrides,
  }
}

function buildApp(actor: Record<string, any>) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = actor
  })
  return app.register(storeOverviewRoutes, { prefix: '/api/stores' })
}

function mockStoreExists(exists: boolean) {
  vi.spyOn(prisma.store, 'findFirst').mockResolvedValue(
    exists ? { id: 'store-1' } : null,
  )
}

function mockOrderCounts(submitted: number, confirmed: number, delivering: number) {
  vi.spyOn(prisma.purchaseOrder, 'count').mockImplementation(async ({ where }: any) => {
    switch (where?.status) {
      case 'SUBMITTED': return submitted
      case 'CONFIRMED': return confirmed
      case 'DELIVERING': return delivering
      default: return 0
    }
  })
}

function mockReceiptCount(count: number) {
  vi.spyOn(prisma.receipt, 'count').mockResolvedValue(count)
}

function mockConsumptionCount(count: number) {
  vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(count)
}

function mockInventory(itemCount: number, lowStockCount: number) {
  mockEstimatedStoreInventory.mockResolvedValue({
    summary: {
      status: itemCount > 0 ? 'AVAILABLE' : 'NO_BASELINE',
      basis: 'ESTIMATED_FROM_PHYSICAL_COUNT',
      isRealtime: itemCount > 0,
      asOf: null,
      openingDate: null,
      totalValue: null,
      itemCount,
      nonzeroCount: 0,
      zeroCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      normalizationPendingCount: 0,
      lowStockCount,
      sourceFilename: null,
    },
    items: [],
  } as any)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('store overview API', () => {
  it('returns precise status breakdown and inventory stats for SUPPLY_CHAIN role', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    mockOrderCounts(3, 2, 1)
    mockReceiptCount(10)
    mockConsumptionCount(42)
    mockInventory(25, 1)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.orderCount).toBe(6)
    expect(body.orderStatusBreakdown).toEqual({
      SUBMITTED: 3,
      CONFIRMED: 2,
      DELIVERING: 1,
      inProgress: 6,
    })
    expect(body.validReceiptCount).toBe(10)
    expect(body.inventoryProductCount).toBe(25)
    expect(body.lowStockCount).toBe(1)
    expect(body.consumptionCount30d).toBe(42)
  })

  it('excludes voided consumptions from the 30-day count', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    mockOrderCounts(0, 0, 0)
    mockReceiptCount(0)
    mockInventory(0, 0)

    const consumptionSpy = vi.spyOn(prisma.stockConsumption, 'count').mockResolvedValue(5)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json().consumptionCount30d).toBe(5)
    const callArgs = consumptionSpy.mock.calls[0]?.[0] as any
    expect(callArgs?.where?.voidedAt).toBeNull()
    expect(callArgs?.where?.date).toBeDefined()
  })

  it('returns 404 for cross-tenant store (store not found)', async () => {
    const actor = makeActor({ tenantId: 'tenant-a' })
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-other-tenant/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('门店不存在')
  })

  it('rejects external supplier roles with 403', async () => {
    const actor = makeActor({ role: 'SUPPLIER_OWNER', supplierId: 'sup-1' })
    const app = buildApp(actor)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('无权访问门店概览')
  })

  it('rejects MANAGER role with 403', async () => {
    const actor = makeActor({ role: 'MANAGER', storeId: 'store-1' })
    const app = buildApp(actor)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('无权访问门店概览')
  })

  it('returns all zeros for an empty store with no data', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    mockOrderCounts(0, 0, 0)
    mockReceiptCount(0)
    mockConsumptionCount(0)
    mockInventory(0, 0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-empty/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.orderCount).toBe(0)
    expect(body.orderStatusBreakdown.inProgress).toBe(0)
    expect(body.validReceiptCount).toBe(0)
    expect(body.inventoryProductCount).toBe(0)
    expect(body.lowStockCount).toBe(0)
    expect(body.consumptionCount30d).toBe(0)
  })

  it('allows ADMIN role', async () => {
    const actor = makeActor({ role: 'ADMIN' })
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    mockOrderCounts(1, 0, 0)
    mockReceiptCount(2)
    mockConsumptionCount(3)
    mockInventory(0, 0)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json().orderStatusBreakdown.SUBMITTED).toBe(1)
  })

  it('uses the current estimated inventory summary instead of the last physical count', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    mockOrderCounts(0, 0, 0)
    mockReceiptCount(0)
    mockConsumptionCount(0)
    mockInventory(3, 3)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/overview',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.inventoryProductCount).toBe(3)
    expect(body.lowStockCount).toBe(3)
    expect(mockEstimatedStoreInventory).toHaveBeenCalledWith('tenant-a', 'store-1')
  })

  it('returns product consumption Top 10 from frozen historical cost amounts', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    vi.spyOn(prisma, '$queryRaw')
      .mockResolvedValueOnce([{
        totalAmount: 1000,
        recordCount: 120,
        pricedRecordCount: 110,
      }] as any)
      .mockResolvedValueOnce([
        {
          id: 'product-1',
          name: '牛肝菌',
          code: 'SKU-001',
          category: '菌菇',
          amount: 400,
          recordCount: 20,
          pricedRecordCount: 20,
        },
        {
          id: 'product-2',
          name: '土豆',
          code: 'SKU-002',
          category: '蔬菜',
          amount: 250,
          recordCount: 30,
          pricedRecordCount: 25,
        },
      ] as any)

    const res = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/consumption-ranking?days=30&dimension=PRODUCT',
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      dimension: 'PRODUCT',
      days: 30,
      totalAmount: 1000,
      top10Amount: 650,
      top10Coverage: 0.65,
      recordCount: 120,
      pricedRecordCount: 110,
      unpricedRecordCount: 10,
      items: [
        { id: 'product-1', name: '牛肝菌', amount: 400, share: 0.4 },
        { id: 'product-2', name: '土豆', amount: 250, share: 0.25 },
      ],
    })
  })

  it('supports category ranking and rejects unsupported ranges', async () => {
    const actor = makeActor()
    const app = buildApp(actor)
    await app.ready()

    mockStoreExists(true)
    vi.spyOn(prisma, '$queryRaw')
      .mockResolvedValueOnce([{
        totalAmount: 500,
        recordCount: 30,
        pricedRecordCount: 30,
      }] as any)
      .mockResolvedValueOnce([{
        id: '蔬菜',
        name: '蔬菜',
        code: null,
        category: '蔬菜',
        amount: 300,
        recordCount: 18,
        pricedRecordCount: 18,
      }] as any)

    const category = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/consumption-ranking?days=7&dimension=CATEGORY',
    })
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/stores/store-1/consumption-ranking?days=31&dimension=PRODUCT',
    })
    await app.close()

    expect(category.statusCode).toBe(200)
    expect(category.json()).toMatchObject({
      dimension: 'CATEGORY',
      days: 7,
      items: [{ id: '蔬菜', name: '蔬菜', amount: 300 }],
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toContain('7、30 或 90 天')
  })

  it('keeps ranking tenant-scoped and rejects external supplier roles', async () => {
    const crossTenantApp = buildApp(makeActor({ tenantId: 'tenant-a' }))
    await crossTenantApp.ready()
    mockStoreExists(false)

    const missing = await crossTenantApp.inject({
      method: 'GET',
      url: '/api/stores/store-other/consumption-ranking',
    })
    await crossTenantApp.close()
    expect(missing.statusCode).toBe(404)

    vi.restoreAllMocks()
    const supplierApp = buildApp(makeActor({ role: 'SUPPLIER_OWNER', supplierId: 'supplier-1' }))
    await supplierApp.ready()
    const forbidden = await supplierApp.inject({
      method: 'GET',
      url: '/api/stores/store-1/consumption-ranking',
    })
    await supplierApp.close()

    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toBe('无权访问门店消耗排行')
  })
})
