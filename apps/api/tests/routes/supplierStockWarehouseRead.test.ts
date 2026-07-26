import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

const actor = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  supplierId: 'supplier-a',
  role: 'SUPPLIER_OWNER',
}

const warehouses = [
  { id: 'wh-a-default', name: 'A 默认仓', tenantId: 'tenant-a', isDefault: true, isActive: true },
  { id: 'wh-a-active', name: 'A 二号仓', tenantId: 'tenant-a', isDefault: false, isActive: true },
  { id: 'wh-a-disabled', name: 'A 停用仓', tenantId: 'tenant-a', isDefault: false, isActive: false },
  { id: 'wh-b-default', name: 'B 默认仓', tenantId: 'tenant-b', isDefault: true, isActive: true },
]

function mockWarehouseFindFirst(rows: typeof warehouses) {
  return vi.spyOn(prisma.warehouse, 'findFirst').mockImplementation(async (args: any) => {
    const where = args.where || {}
    const candidate = rows.find(row => {
      if (row.tenantId !== where.tenantId) return false
      if ('isDefault' in where && row.isDefault !== where.isDefault) return false
      if ('id' in where && row.id !== where.id) return false
      if ('isActive' in where && row.isActive !== where.isActive) return false
      return true
    })
    return candidate ? { id: candidate.id, name: candidate.name } : null
  })
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    code: 'C001',
    name: '香菇',
    spec: '一级',
    unit: '斤',
    category: '菌菇',
    stock: new Prisma.Decimal(10),
    minStock: new Prisma.Decimal(3),
    price: new Prisma.Decimal(2),
    shelfDays: 7,
    purchaseUnit: null,
    inventoryUnit: null,
    orderUnit: null,
    costUnit: null,
    inventoryUnitsPerPurchaseUnit: null,
    inventoryUnitsPerOrderUnit: null,
    inventoryUnitsPerCostUnit: null,
    unitConversionStatus: 'PENDING',
    ...overrides,
  }
}

function mockStockListFacts(options: {
  products?: any[]
  warehouseStocks?: any[]
  reservations?: any[]
  movements?: any[]
  batches?: any[]
} = {}) {
  const products = options.products ?? [product()]
  const warehouseStocks = options.warehouseStocks ?? products.map(row => ({
    productId: row.id,
    physicalQty: row.stock,
    isActive: true,
  }))
  const productFindMany = vi.spyOn(prisma.product, 'findMany').mockResolvedValue(products as any)
  const stockFindMany = vi.spyOn(prisma.warehouseStock, 'findMany').mockResolvedValue(warehouseStocks as any)
  const reservationGroupBy = vi.spyOn(prisma.supplierStockReservation, 'groupBy')
    .mockResolvedValue((options.reservations ?? []) as any)
  const movementFindMany = vi.spyOn(prisma.supplierStockMovement, 'findMany')
    .mockResolvedValue((options.movements ?? []) as any)
  const batchFindMany = vi.spyOn(prisma.supplierStockBatch, 'findMany')
    .mockResolvedValue((options.batches ?? []) as any)
  return {
    productFindMany,
    stockFindMany,
    reservationGroupBy,
    movementFindMany,
    batchFindMany,
  }
}

function spyOnReadPathWrites() {
  const targets: Array<[any, string[]]> = [
    [prisma.warehouseStock, ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']],
    [prisma.product, ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']],
    [prisma.supplierStockReservation, ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']],
    [prisma.supplierStockMovement, ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']],
    [prisma.supplierStockBatch, ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']],
  ]
  return targets.flatMap(([model, methods]) => methods.map(method => vi.spyOn(model, method)))
}

async function buildApp(user: Record<string, unknown> = actor) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = user
  })
  await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
  await app.ready()
  return app
}

describe('supplier stock warehouse-scoped read endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET /api/supplier/stock', () => {
    it('requires an explicit supplierId for internal SUPPLY_CHAIN and keeps external suppliers self-bound', async () => {
      const internalApp = await buildApp({
        tenantId: actor.tenantId,
        userId: 'internal-user',
        role: 'SUPPLY_CHAIN',
      })
      try {
        const missing = await internalApp.inject({ method: 'GET', url: '/api/supplier/stock' })
        expect(missing.statusCode).toBe(400)

        mockWarehouseFindFirst(warehouses)
        const internalMocks = mockStockListFacts()
        const selected = await internalApp.inject({
          method: 'GET',
          url: '/api/supplier/stock?supplierId=supplier-selected',
        })
        expect(selected.statusCode).toBe(200)
        expect(internalMocks.productFindMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: 'supplier-selected',
        })
      } finally {
        await internalApp.close()
      }

      vi.restoreAllMocks()
      const externalApp = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const externalMocks = mockStockListFacts()
        const res = await externalApp.inject({
          method: 'GET',
          url: '/api/supplier/stock?supplierId=supplier-other',
        })
        expect(res.statusCode).toBe(200)
        expect(externalMocks.productFindMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
        })
      } finally {
        await externalApp.close()
      }
    })

    it.each([
      { query: '', expectedId: 'wh-a-default', expectedName: 'A 默认仓' },
      { query: '?warehouseId=default', expectedId: 'wh-a-default', expectedName: 'A 默认仓' },
      { query: '?warehouseId=wh-a-active', expectedId: 'wh-a-active', expectedName: 'A 二号仓' },
    ])('resolves $query to an enabled real warehouse', async ({ query, expectedId, expectedName }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const mocks = mockStockListFacts()

        const res = await app.inject({ method: 'GET', url: `/api/supplier/stock${query}` })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject([{ id: 'p1', stock: 10, physicalStock: 10, warehouseId: expectedId }])
        expect(mocks.stockFindMany.mock.calls[0][0].where).toEqual({
          tenantId: actor.tenantId,
          warehouseId: expectedId,
          productId: { in: ['p1'] },
        })
        expect(prisma.warehouse.findFirst).toHaveBeenLastCalledWith({
          where: { tenantId: actor.tenantId, id: expectedId, isActive: true },
          select: { id: true, name: true },
        })
        expect(expectedName).toBe(warehouses.find(row => row.id === expectedId)?.name)
      } finally {
        await app.close()
      }
    })

    it('filters the product catalog, sorts by physicalQty/name/id before pagination, and returns real metadata', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const products = [
          product({ id: 'p-z', code: 'Z', name: '白菜', category: '蔬菜', stock: new Prisma.Decimal(8) }),
          product({ id: 'p-b', code: 'B', name: '菠菜', category: '蔬菜', stock: new Prisma.Decimal(2) }),
          product({ id: 'p-a', code: 'A', name: '菠菜', category: '蔬菜', stock: new Prisma.Decimal(2) }),
        ]
        const mocks = mockStockListFacts({ products })

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock?warehouseId=wh-a-active&page=2&pageSize=1&q=%E8%8F%A0&category=%E8%94%AC%E8%8F%9C',
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({
          items: [{ id: 'p-b', stock: 2, warehouseId: 'wh-a-active' }],
          total: 3,
          page: 2,
          pageSize: 1,
          totalPages: 3,
          warehouse: { id: 'wh-a-active', name: 'A 二号仓' },
        })
        expect(mocks.productFindMany.mock.calls[0][0]).toMatchObject({
          where: {
            tenantId: actor.tenantId,
            supplierId: actor.supplierId,
            status: 'ENABLED',
            category: '蔬菜',
          },
        })
        expect(mocks.productFindMany.mock.calls[0][0]).not.toHaveProperty('skip')
        expect(mocks.productFindMany.mock.calls[0][0]).not.toHaveProperty('take')
      } finally {
        await app.close()
      }
    })

    it('limits reservations, movements, and expiry batches to the same tenant/supplier/warehouse/products', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const now = new Date()
        const mocks = mockStockListFacts({
          reservations: [{ productId: 'p1', _sum: { quantity: new Prisma.Decimal(4) } }],
          movements: [
            { productId: 'p1', delta: new Prisma.Decimal(3), createdAt: now, type: 'INBOUND_MANUAL' },
            { productId: 'p1', delta: new Prisma.Decimal(-2), createdAt: now, type: 'OUTBOUND_PO' },
          ],
          batches: [{ productId: 'p1', expiryDate: new Date(Date.now() + 2 * 86400_000) }],
        })

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock?warehouseId=wh-a-active&page=1&pageSize=10',
        })

        expect(res.statusCode).toBe(200)
        expect(res.json().items[0]).toMatchObject({
          physicalStock: 10,
          reservedStock: 4,
          availableStock: 6,
          in7d: 3,
          out7d: 2,
          in30d: 3,
          out30d: 2,
        })
        const sharedScope = {
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-active',
          productId: { in: ['p1'] },
        }
        expect(mocks.reservationGroupBy.mock.calls[0][0].where).toMatchObject({
          ...sharedScope,
          status: 'ACTIVE',
        })
        expect(mocks.movementFindMany.mock.calls[0][0].where).toMatchObject(sharedScope)
        expect(mocks.batchFindMany.mock.calls[0][0].where).toMatchObject({
          ...sharedScope,
          remainingQty: { gt: 0 },
          expiryDate: { not: null },
        })
      } finally {
        await app.close()
      }
    })

    it.each([
      { label: 'missing', rows: [] },
      { label: 'inactive', rows: [{ productId: 'p1', physicalQty: new Prisma.Decimal(10), isActive: false }] },
      { label: 'drifted', rows: [{ productId: 'p1', physicalQty: new Prisma.Decimal('10.001'), isActive: true }] },
    ])('returns 409 when WarehouseStock is $label', async ({ rows }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const mocks = mockStockListFacts({ warehouseStocks: rows })

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock?page=99&pageSize=10' })

        expect(res.statusCode).toBe(409)
        expect(mocks.reservationGroupBy).not.toHaveBeenCalled()
        expect(mocks.movementFindMany).not.toHaveBeenCalled()
        expect(mocks.batchFindMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })

    it.each(['wh-a-disabled', 'wh-b-default', 'unknown-wh'])(
      'fails closed for warehouse %s before reading stock',
      async (warehouseId) => {
        const app = await buildApp()
        try {
          mockWarehouseFindFirst(warehouses)
          const mocks = mockStockListFacts()

          const res = await app.inject({
            method: 'GET',
            url: `/api/supplier/stock?warehouseId=${warehouseId}`,
          })

          expect(res.statusCode).toBe(404)
          expect(mocks.productFindMany).not.toHaveBeenCalled()
          expect(mocks.stockFindMany).not.toHaveBeenCalled()
        } finally {
          await app.close()
        }
      },
    )
  })

  describe('GET /api/supplier/stock/summary', () => {
    it('uses warehouse physical balances and same-warehouse ACTIVE reservations for four-unit valuation', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        vi.spyOn(prisma.supplier, 'findFirst').mockResolvedValue({
          inventoryMode: 'TRACKED',
          inventoryActivatedAt: new Date('2026-07-01T00:00:00.000Z'),
        } as any)
        const products = [
          product({
            id: 'valued',
            name: '计价品',
            stock: new Prisma.Decimal(10),
            minStock: new Prisma.Decimal(8),
            price: new Prisma.Decimal('0.02'),
            purchaseUnit: '箱',
            inventoryUnit: 'g',
            orderUnit: '斤',
            costUnit: 'g',
            inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(10000),
            inventoryUnitsPerOrderUnit: new Prisma.Decimal(500),
            inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
            unitConversionStatus: 'VERIFIED',
          }),
          product({
            id: 'pending',
            name: '待核价品',
            stock: new Prisma.Decimal(5),
            minStock: new Prisma.Decimal(1),
            price: new Prisma.Decimal(99),
            purchaseUnit: '箱',
          }),
        ]
        mockStockListFacts({
          products,
          reservations: [
            { productId: 'valued', _sum: { quantity: new Prisma.Decimal(3) } },
            { productId: 'pending', _sum: { quantity: new Prisma.Decimal(5) } },
          ],
        })

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/summary?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({
          totalSku: 2,
          lowStock: 1,
          outOfStock: 1,
          valuationPendingSku: 1,
          totalValue: 100,
          availableValue: 70,
          reservedValue: 30,
          warehouse: { id: 'wh-a-active', name: 'A 二号仓' },
        })
        expect((prisma.supplierStockReservation.groupBy as any).mock.calls[0][0].where).toEqual({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-active',
          productId: { in: ['valued', 'pending'] },
          status: 'ACTIVE',
        })
      } finally {
        await app.close()
      }
    })

    it.each([
      { label: 'missing', rows: [] },
      { label: 'inactive', rows: [{ productId: 'p1', physicalQty: new Prisma.Decimal(10), isActive: false }] },
      { label: 'drifted', rows: [{ productId: 'p1', physicalQty: new Prisma.Decimal(9), isActive: true }] },
    ])('returns 409 when summary WarehouseStock is $label', async ({ rows }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        vi.spyOn(prisma.supplier, 'findFirst').mockResolvedValue({
          inventoryMode: 'TRACKED',
          inventoryActivatedAt: null,
        } as any)
        mockStockListFacts({ warehouseStocks: rows })

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/summary' })

        expect(res.statusCode).toBe(409)
        expect(prisma.supplierStockReservation.groupBy).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })

    it('performs no writes on successful list and summary reads', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        vi.spyOn(prisma.supplier, 'findFirst').mockResolvedValue({
          inventoryMode: 'TRACKED',
          inventoryActivatedAt: null,
        } as any)
        mockStockListFacts()
        const writes = spyOnReadPathWrites()

        const list = await app.inject({ method: 'GET', url: '/api/supplier/stock' })
        const summary = await app.inject({ method: 'GET', url: '/api/supplier/stock/summary' })

        expect(list.statusCode).toBe(200)
        expect(summary.statusCode).toBe(200)
        for (const write of writes) expect(write).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('GET /api/supplier/stock/reservations', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/reservations' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
          status: 'ACTIVE',
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'r1',
          quantity: 10,
          fulfilledQty: 2,
          createdAt: new Date(),
          product: { id: 'p1', code: 'C001', name: '香菇', unit: '斤' },
          purchaseOrder: {
            id: 'po1',
            no: 'PO001',
            status: 'PENDING',
            expectedDate: new Date(),
            createdAt: new Date(),
            store: { id: 's1', name: '一店' },
          },
        }
        vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/reservations?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/reservations?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('GET /api/supplier/stock/batches', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/batches' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
          remainingQty: { gt: 0 },
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'b1',
          batchNo: 'B001',
          kind: 'INBOUND',
          initialQty: 100,
          remainingQty: 80,
          manufactureDate: null,
          expiryDate: null,
          depletedAt: null,
          createdAt: new Date(),
          product: { id: 'p1', code: 'C001', name: '香菇', unit: '斤', spec: '一级' },
          sourceMovement: { id: 'm1', type: 'INBOUND_MANUAL', reason: null, sourceType: 'Manual', sourceId: null },
        }
        vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/batches?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/batches?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('GET /api/supplier/stock/movements', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/movements' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'm1',
          type: 'INBOUND_MANUAL',
          delta: 50,
          balanceAfter: 150,
          reason: null,
          sourceType: 'Manual',
          sourceId: null,
          manufactureDate: null,
          expiryDate: null,
          createdAt: new Date(),
          product: { name: '香菇', code: 'C001', unit: '斤', spec: '一级' },
          createdBy: { name: '操作员' },
        }
        vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/movements?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/movements?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('unswitched write endpoints still reject a real non-default warehouse', () => {
    const lockedEndpoints: Array<{ method: 'GET' | 'POST'; url: string; payload?: any }> = [
      { method: 'POST', url: '/api/supplier/stock/inbound?warehouseId=wh-a-active', payload: { items: [{ productId: 'p1', qty: 1 }] } },
      { method: 'POST', url: '/api/supplier/stock/adjust?warehouseId=wh-a-active', payload: { productId: 'p1', newQty: 1, reason: '盘点' } },
      { method: 'POST', url: '/api/supplier/stock/loss?warehouseId=wh-a-active', payload: { productId: 'p1', qty: 1, reason: '报损' } },
      { method: 'POST', url: '/api/supplier/stock/import-snapshot?warehouseId=wh-a-active', payload: { items: [{ name: 'x', qty: 1 }] } },
    ]

    it.each(lockedEndpoints)('rejects real non-default warehouse on $method $url', async ({ method, url, payload }) => {
      const app = await buildApp()
      try {
        const res = await app.inject({ method, url, payload })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toContain('未知仓库')
      } finally {
        await app.close()
      }
    })
  })
})
