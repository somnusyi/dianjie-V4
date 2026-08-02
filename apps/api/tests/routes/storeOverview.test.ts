import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
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

function mockRunboardOrders(overrides: { today?: any[]; latest?: any; statuses?: any[]; overdue?: any[] } = {}) {
  const { today = [], latest = null, statuses = [], overdue = [] } = overrides
  vi.spyOn(prisma.purchaseOrder, 'findMany').mockImplementation(async ({ where }: any) => {
    if (where?.createdAt) return today
    if (where?.expectedDate) return overdue
    return []
  })
  vi.spyOn(prisma.purchaseOrder, 'findFirst').mockResolvedValue(latest)
  vi.spyOn(prisma.purchaseOrder, 'groupBy').mockResolvedValue(statuses as any)
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

describe('store order runboard API', () => {
  it('returns today order summary, status breakdown and overdue list', async () => {
    const app = buildApp(makeActor())
    await app.ready()

    mockStoreExists(true)
    mockRunboardOrders({
      today: [{
        id: 'order-today-1',
        no: 'PO-TODAY-1',
        status: 'SUBMITTED',
        createdAt: new Date('2026-07-26T01:30:00+08:00'),
        currentOrderAmount: new Prisma.Decimal('350.00'),
        originalTotalAmount: null,
        totalAmount: new Prisma.Decimal('350.00'),
        _count: { items: 3 },
      }],
      latest: {
        id: 'order-today-1',
        no: 'PO-TODAY-1',
        status: 'SUBMITTED',
        createdAt: new Date('2026-07-26T01:30:00+08:00'),
      },
      statuses: [
        { status: 'SUBMITTED', _count: { _all: 3 } },
        { status: 'CONFIRMED', _count: { _all: 2 } },
        { status: 'DELIVERING', _count: { _all: 1 } },
        { status: 'PENDING_CONFIRM', _count: { _all: 0 } },
        { status: 'RECEIVED', _count: { _all: 4 } },
        { status: 'COMPLETED', _count: { _all: 2 } },
        { status: 'CANCELLED', _count: { _all: 1 } },
      ],
      overdue: [{
        id: 'order-overdue-1',
        no: 'PO-OVERDUE-1',
        status: 'SUBMITTED',
        createdAt: new Date('2026-07-20T08:00:00+08:00'),
        expectedDate: new Date('2026-07-25T00:00:00.000Z'),
        currentOrderAmount: new Prisma.Decimal('120.00'),
        originalTotalAmount: null,
        totalAmount: new Prisma.Decimal('120.00'),
        _count: { items: 2 },
      }],
    })

    const res = await app.inject({ method: 'GET', url: '/api/stores/store-1/order-runboard' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.todayOrders).toEqual({ count: 1, itemCount: 3, totalAmount: '350.00' })
    expect(body.latestOrder?.no).toBe('PO-TODAY-1')
    expect(body.statusBreakdown).toEqual({
      SUBMITTED: 3,
      CONFIRMED: 2,
      DELIVERING: 1,
      PENDING_CONFIRM: 0,
      RECEIVED: 4,
      COMPLETED: 2,
      CANCELLED: 1,
      inProgress: 6,
    })
    expect(body.overdue.count).toBe(1)
    expect(body.overdue.orders[0]).toMatchObject({
      no: 'PO-OVERDUE-1',
      status: 'SUBMITTED',
      expectedDate: '2026-07-25',
      itemCount: 2,
      totalAmount: '120.00',
    })
    expect(body.overdue.orders[0].overdueDays).toBeGreaterThan(0)
  })

  it('scopes overdue to running statuses with expected date before today', async () => {
    const app = buildApp(makeActor())
    await app.ready()

    mockStoreExists(true)
    mockRunboardOrders()

    await app.inject({ method: 'GET', url: '/api/stores/store-1/order-runboard' })
    await app.close()

    const findMany = vi.mocked(prisma.purchaseOrder.findMany)
    const overdueCall = findMany.mock.calls.find(([args]) => (args as any)?.where?.expectedDate)
    expect(overdueCall).toBeDefined()
    const statusIn = (overdueCall![0] as any).where.status.in
    expect(statusIn).toEqual(['SUBMITTED', 'CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM'])
    expect(statusIn).not.toContain('DRAFT')
    expect(statusIn).not.toContain('RECEIVED')
    expect(statusIn).not.toContain('COMPLETED')
    expect(statusIn).not.toContain('CANCELLED')
    expect((overdueCall![0] as any).where.expectedDate.lt).toBeDefined()

    const todayCall = findMany.mock.calls.find(([args]) => (args as any)?.where?.createdAt)
    expect(todayCall).toBeDefined()
    expect((todayCall![0] as any).where.status.notIn).toEqual(['DRAFT', 'CANCELLED'])
  })

  it('rejects external supplier roles and cross-tenant stores for the runboard', async () => {
    const supplierApp = buildApp(makeActor({ role: 'SUPPLIER_OWNER', supplierId: 'supplier-1' }))
    await supplierApp.ready()
    const forbidden = await supplierApp.inject({ method: 'GET', url: '/api/stores/store-1/order-runboard' })
    await supplierApp.close()
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error).toBe('无权访问门店订货运行')

    vi.restoreAllMocks()
    const crossApp = buildApp(makeActor({ tenantId: 'tenant-a' }))
    await crossApp.ready()
    mockStoreExists(false)
    const missing = await crossApp.inject({ method: 'GET', url: '/api/stores/store-other/order-runboard' })
    await crossApp.close()
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('门店不存在')
  })
})

describe('store order simulation API', () => {
  const draftProduct = {
    id: 'product-1',
    supplierId: 'supplier-1',
    code: 'SKU-001',
    name: '乌苏罐装',
    category: '饮品',
    spec: '6罐/箱',
    unit: '罐',
    imageKey: null,
    price: new Prisma.Decimal(5),
    stock: new Prisma.Decimal(10),
    minOrderQty: new Prisma.Decimal(2),
    stepQty: new Prisma.Decimal(2),
    purchaseUnit: '箱',
    inventoryUnit: '罐',
    orderUnit: '罐',
    costUnit: '罐',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(6),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    unitConversionStatus: 'VERIFIED',
  }

  function mockSimulationStore() {
    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue({
      id: 'store-1', no: 'S001', name: '瑶海店', status: 'ACTIVE',
    } as any)
  }

  it('returns the enabled real catalog with availability without writing business data', async () => {
    const app = buildApp(makeActor())
    await app.ready()
    mockSimulationStore()
    vi.spyOn(prisma.supplier, 'findMany').mockResolvedValue([
      { id: 'supplier-1', name: '内部供应链', category: '综合', inventoryMode: 'STRICT' },
    ] as any)
    const productFind = vi.spyOn(prisma.product, 'findMany').mockResolvedValue([draftProduct] as any)
    vi.spyOn(prisma.supplierStockReservation, 'groupBy').mockResolvedValue([
      { productId: 'product-1', _sum: { quantity: new Prisma.Decimal(3) } },
    ] as any)

    const res = await app.inject({ method: 'GET', url: '/api/stores/store-1/order-simulation/catalog' })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(productFind.mock.calls[0][0]?.where).toMatchObject({
      tenantId: 'tenant-a', status: 'ENABLED', supplier: { status: 'ENABLED' },
    })
    expect(res.json()).toMatchObject({
      mode: 'SIMULATION',
      store: { id: 'store-1', name: '瑶海店' },
      products: [{ id: 'product-1', physicalStock: 10, reservedStock: 3, availableStock: 7 }],
    })
  })

  it('dry-runs the shared order rules and never creates an order or inventory event', async () => {
    const app = buildApp(makeActor())
    await app.ready()
    mockSimulationStore()
    vi.spyOn(prisma.supplier, 'findFirst').mockResolvedValue({
      id: 'supplier-1', name: '内部供应链', inventoryMode: 'STRICT',
    } as any)
    vi.spyOn(prisma.product, 'findMany')
      .mockResolvedValueOnce([draftProduct] as any)
      .mockResolvedValueOnce([{ id: 'product-1', name: '乌苏罐装', stock: new Prisma.Decimal(10) }] as any)
    vi.spyOn(prisma.supplierStockReservation, 'groupBy').mockResolvedValue([] as any)
    const orderCreate = vi.spyOn(prisma.purchaseOrder, 'create')
    const movementCreate = vi.spyOn(prisma.supplierStockMovement, 'create')

    const res = await app.inject({
      method: 'POST',
      url: '/api/stores/store-1/order-simulation/preflight',
      payload: { supplierId: 'supplier-1', items: [{ productId: 'product-1', quantity: 4 }] },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      mode: 'SIMULATION', persisted: false, canSubmit: true, canCompleteFlow: true,
      totalAmount: '20.00', issues: [],
    })
    expect(orderCreate).not.toHaveBeenCalled()
    expect(movementCreate).not.toHaveBeenCalled()
  })

  it('reports STRICT stock as a supplier-acceptance blocker without reserving it', async () => {
    const app = buildApp(makeActor())
    await app.ready()
    mockSimulationStore()
    vi.spyOn(prisma.supplier, 'findFirst').mockResolvedValue({
      id: 'supplier-1', name: '内部供应链', inventoryMode: 'STRICT',
    } as any)
    vi.spyOn(prisma.product, 'findMany')
      .mockResolvedValueOnce([draftProduct] as any)
      .mockResolvedValueOnce([{ id: 'product-1', name: '乌苏罐装', stock: new Prisma.Decimal(3) }] as any)
    vi.spyOn(prisma.supplierStockReservation, 'groupBy').mockResolvedValue([
      { productId: 'product-1', _sum: { quantity: new Prisma.Decimal(1) } },
    ] as any)

    const res = await app.inject({
      method: 'POST',
      url: '/api/stores/store-1/order-simulation/preflight',
      payload: { supplierId: 'supplier-1', items: [{ productId: 'product-1', quantity: 4 }] },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      persisted: false,
      canSubmit: true,
      canCompleteFlow: false,
      issues: [{ stage: 'SUPPLIER_ACCEPT', productId: 'product-1' }],
    })
  })

  it('rejects external supplier accounts and cross-tenant stores', async () => {
    const supplierApp = buildApp(makeActor({ role: 'SUPPLIER_OWNER', supplierId: 'supplier-1' }))
    await supplierApp.ready()
    const forbidden = await supplierApp.inject({
      method: 'GET', url: '/api/stores/store-1/order-simulation/catalog',
    })
    await supplierApp.close()
    expect(forbidden.statusCode).toBe(403)

    const supplyApp = buildApp(makeActor())
    await supplyApp.ready()
    vi.spyOn(prisma.store, 'findFirst').mockResolvedValue(null)
    const missing = await supplyApp.inject({
      method: 'POST',
      url: '/api/stores/other-tenant/order-simulation/preflight',
      payload: { supplierId: 'supplier-1', items: [{ productId: 'product-1', quantity: 2 }] },
    })
    await supplyApp.close()
    expect(missing.statusCode).toBe(404)
  })
})
