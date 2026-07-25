import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  productCreate: vi.fn(),
  productUpdate: vi.fn(),
  productUpdateMany: vi.fn(),
  productFindFirst: vi.fn(),
  productFindUniqueOrThrow: vi.fn(),
  supplierFindFirst: vi.fn(),
  categoryFindUnique: vi.fn(),
  stockMovementCreate: vi.fn(),
  opLogCreate: vi.fn(),
  documentCreate: vi.fn(),
  notifyProductChange: vi.fn(),
  invalidatePattern: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock('@dianjie/db', () => {
  const prismaMock: any = {
    $transaction: vi.fn(async (fn: any) => fn(prismaMock)),
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
    product: {
      create: (...args: any[]) => mocks.productCreate(...args),
      update: (...args: any[]) => mocks.productUpdate(...args),
      updateMany: (...args: any[]) => mocks.productUpdateMany(...args),
      findFirst: (...args: any[]) => mocks.productFindFirst(...args),
      findUniqueOrThrow: (...args: any[]) => mocks.productFindUniqueOrThrow(...args),
    },
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    supplierProductCategory: {
      findUnique: (...args: any[]) => mocks.categoryFindUnique(...args),
      aggregate: vi.fn(),
      createMany: vi.fn(),
    },
    supplierStockMovement: { create: (...args: any[]) => mocks.stockMovementCreate(...args) },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
    document: {
      create: (...args: any[]) => mocks.documentCreate(...args),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  }
  return { prisma: prismaMock }
})

vi.mock('../../src/services/notify/productChange', () => ({
  fireAndForgetNotifyProductChange: (...args: any[]) => mocks.notifyProductChange(...args),
}))

vi.mock('../../src/services/notify', () => ({ fireAndForget: vi.fn() }))
vi.mock('../../src/services/documentNo', () => ({ nextDocumentNo: vi.fn() }))
vi.mock('../../src/services/supplierStockBatch', () => ({ createSupplierStockBatchIncrease: vi.fn() }))
vi.mock('../../src/services/supplierStockReservation', () => ({
  getSupplierReservedStock: vi.fn(),
  stockAvailability: vi.fn(),
}))
vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => any) => fn(),
  invalidatePattern: (...args: any[]) => mocks.invalidatePattern(...args),
}))
vi.mock('../../src/routes/upload', () => ({ signOssKey: vi.fn(() => null) }))

import { productRoutes } from '../../src/routes/products'

const tenantId = 'tenant-four-units'
const supplyChainUserId = 'user-four-units'
const productId = 'product-four-units'

function product(overrides: Record<string, any> = {}) {
  return {
    id: productId,
    tenantId,
    supplierId: null,
    code: 'UNIT-001',
    name: '四单位商品',
    spec: null,
    category: '其他',
    imageKey: null,
    unit: '箱',
    purchaseUnit: '箱',
    inventoryUnit: '瓶',
    orderUnit: '箱',
    costUnit: '瓶',
    inventoryUnitsPerPurchaseUnit: 12,
    inventoryUnitsPerOrderUnit: 12,
    inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED',
    unitConversionNote: null,
    unitConversionVerifiedAt: new Date('2026-07-26T00:00:00.000Z'),
    price: 24,
    stock: 0,
    minOrderQty: 1,
    stepQty: 1,
    shelfDays: 7,
    status: 'ENABLED',
    shipUpperPct: 1.1,
    shipUpperBuffer: 5,
    ...overrides,
  }
}

describe('product four-unit master-data contract (document snapshots are next phase)', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId,
        userId: supplyChainUserId,
        role: 'SUPPLY_CHAIN',
      }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executeRaw.mockResolvedValue([])
    mocks.queryRaw.mockResolvedValue([])
    mocks.opLogCreate.mockResolvedValue({})
    mocks.productCreate.mockImplementation(async ({ data }: any) => product({
      ...data,
      id: productId,
      price: Number(data.price),
      stock: Number(data.stock),
    }))
    mocks.productUpdate.mockImplementation(async ({ data }: any) => product(data))
  })

  it('defaults all four units to the legacy unit with factor 1', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: { code: 'DEFAULT-UNIT', name: '默认单位商品' },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.productCreate.mock.calls[0][0].data).toMatchObject({
      unit: '件',
      purchaseUnit: '件',
      inventoryUnit: '件',
      orderUnit: '件',
      costUnit: '件',
      inventoryUnitsPerPurchaseUnit: 1,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'PENDING',
    })
  })

  it('accepts explicit distinct units and factors for internal supply chain', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'EXPLICIT-UNIT',
        name: '显式单位商品',
        unit: '箱',
        purchaseUnit: '箱',
        inventoryUnit: '瓶',
        orderUnit: '托',
        costUnit: '瓶',
        inventoryUnitsPerPurchaseUnit: 12,
        inventoryUnitsPerOrderUnit: 144,
        inventoryUnitsPerCostUnit: 1,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.productCreate.mock.calls[0][0].data).toMatchObject({
      unit: '托',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '托',
      costUnit: '瓶',
      inventoryUnitsPerPurchaseUnit: 12,
      inventoryUnitsPerOrderUnit: 144,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED',
    })
    expect(mocks.notifyProductChange).toHaveBeenCalledWith(expect.objectContaining({
      after: expect.objectContaining({
        purchaseUnit: '箱',
        inventoryUnit: '瓶',
        orderUnit: '托',
        costUnit: '瓶',
        inventoryUnitsPerOrderUnit: 144,
      }),
    }))
  })

  it('rejects non-positive and over-precision factors', async () => {
    for (const inventoryUnitsPerOrderUnit of [0, -1, 1.1234567]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/products',
        payload: {
          code: `BAD-${String(inventoryUnitsPerOrderUnit)}`,
          name: '非法换算',
          unit: '箱',
          orderUnit: '瓶',
          inventoryUnitsPerOrderUnit,
        },
      })
      expect(response.statusCode).toBe(400)
    }
    expect(mocks.productCreate).not.toHaveBeenCalled()
  })

  it('rejects conflicting factors for the same named unit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'AMBIGUOUS-UNIT',
        name: '同名单位歧义',
        purchaseUnit: '箱',
        inventoryUnit: '瓶',
        orderUnit: '箱',
        costUnit: '瓶',
        inventoryUnitsPerPurchaseUnit: 12,
        inventoryUnitsPerOrderUnit: 6,
        inventoryUnitsPerCostUnit: 1,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('同名单位')
    expect(mocks.productCreate).not.toHaveBeenCalled()
  })

  it('rejects a partial edit that would make a same-named unit ambiguous', async () => {
    mocks.productFindFirst.mockResolvedValueOnce(product())

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/products/${productId}`,
      payload: { inventoryUnitsPerOrderUnit: 6 },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('同名单位')
    expect(mocks.productUpdate).not.toHaveBeenCalled()
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })

  it('keeps a legacy body compatible and does not infer from specification text', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'LEGACY-UNIT',
        name: '旧客户端商品',
        unit: '箱',
        spec: '24瓶*330ml/箱',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.productCreate.mock.calls[0][0].data).toMatchObject({
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '箱',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 1,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
    })
  })

  it('enforces tenant scope for create associations and edits', async () => {
    mocks.supplierFindFirst.mockResolvedValue(null)
    const create = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'CROSS-TENANT',
        name: '跨租户商品',
        supplierId: 'foreign-supplier',
        purchaseUnit: '箱',
      },
    })
    expect(create.statusCode).toBe(400)

    mocks.productFindFirst.mockResolvedValue(null)
    const edit = await app.inject({
      method: 'PATCH',
      url: '/api/products/foreign-product',
      payload: { orderUnit: '托', inventoryUnitsPerOrderUnit: 144 },
    })
    expect(edit.statusCode).toBe(404)
    expect(mocks.productUpdate).not.toHaveBeenCalled()
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })

  it('audits and notifies exact four-unit changes, then treats a replay as no-op', async () => {
    const before = product()
    mocks.productFindFirst.mockResolvedValueOnce(before)

    const payload = { orderUnit: '托', inventoryUnitsPerOrderUnit: 144 }
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/products/${productId}`,
      payload,
    })
    const persisted = product(mocks.productUpdate.mock.calls[0][0].data)
    mocks.productFindFirst.mockResolvedValueOnce(persisted)
    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/products/${productId}`,
      payload,
    })

    expect(changed.statusCode).toBe(200)
    expect(replay.json()).toEqual({ count: 0, message: '商品已是目标状态' })
    expect(mocks.opLogCreate).toHaveBeenCalledTimes(1)
    expect(mocks.opLogCreate.mock.calls[0][0].data.metadata).toMatchObject({
      fields: ['orderUnit', 'inventoryUnitsPerOrderUnit', 'unit', 'unitConversionVerifiedAt'],
      before: expect.objectContaining({ orderUnit: '箱', inventoryUnitsPerOrderUnit: 12 }),
      after: expect.objectContaining({
        orderUnit: '托',
        inventoryUnitsPerOrderUnit: 144,
      }),
    })
    expect(mocks.notifyProductChange).toHaveBeenCalledTimes(1)
    expect(mocks.notifyProductChange).toHaveBeenCalledWith(expect.objectContaining({
      before: expect.objectContaining({ orderUnit: '箱', inventoryUnitsPerOrderUnit: 12 }),
      after: expect.objectContaining({ orderUnit: '托', inventoryUnitsPerOrderUnit: 144 }),
    }))
  })
})
