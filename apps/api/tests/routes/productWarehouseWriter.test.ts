import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  warehouseFindFirst: vi.fn(),
  supplierFindFirst: vi.fn(),
  categoryFindUnique: vi.fn(),
  productCreate: vi.fn(),
  movementCreate: vi.fn(),
  batchCreate: vi.fn(),
  opLogCreate: vi.fn(),
  executeRaw: vi.fn(),
  invalidatePattern: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    $transaction: vi.fn(async (fn: any) => fn(prismaMock)),
    $executeRaw: (...args: any[]) => mocks.executeRaw(...args),
    warehouse: {
      findFirst: (...args: any[]) => mocks.warehouseFindFirst(...args),
    },
    supplier: {
      findFirst: (...args: any[]) => mocks.supplierFindFirst(...args),
    },
    supplierProductCategory: {
      findUnique: (...args: any[]) => mocks.categoryFindUnique(...args),
    },
    product: {
      create: (...args: any[]) => mocks.productCreate(...args),
    },
    supplierStockMovement: {
      create: (...args: any[]) => mocks.movementCreate(...args),
    },
    supplierStockBatch: {
      create: (...args: any[]) => mocks.batchCreate(...args),
    },
    opLog: {
      create: (...args: any[]) => mocks.opLogCreate(...args),
    },
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => any) => fn(),
  invalidatePattern: (...args: any[]) => mocks.invalidatePattern(...args),
}))

vi.mock('../../src/services/notify', () => ({
  fireAndForget: vi.fn(),
}))

vi.mock('../../src/services/notify/productChange', () => ({
  fireAndForgetNotifyProductChange: vi.fn(),
}))

vi.mock('../../src/services/supplierStockReservation', () => ({
  getSupplierReservedStock: vi.fn(),
  stockAvailability: vi.fn(),
}))

vi.mock('../../src/services/documentNo', () => ({
  nextDocumentNo: vi.fn(),
}))

vi.mock('../../src/routes/upload', () => ({
  signOssKey: vi.fn(() => null),
}))

import { Prisma } from '@dianjie/db'
import { productRoutes } from '../../src/routes/products'
import { consumeSupplierStockBatches } from '../../src/services/supplierStockBatch'

const tenantId = 'tenant-authenticated'
const supplierId = 'supplier-scoped'
const userId = 'user-supply-chain'
const warehouseId = 'warehouse-real-default'
const productId = 'product-opening'
const movementId = 'movement-opening'
let actorRole = 'SUPPLY_CHAIN'

function createdProduct(data: Record<string, any>) {
  return {
    id: productId,
    tenantId,
    supplierId,
    code: 'OPENING-001',
    name: '期初库存商品',
    spec: null,
    category: '蔬菜',
    imageKey: null,
    unit: '箱',
    purchaseUnit: '箱',
    inventoryUnit: '箱',
    orderUnit: '箱',
    costUnit: '箱',
    inventoryUnitsPerPurchaseUnit: 1,
    inventoryUnitsPerOrderUnit: 1,
    inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'PENDING',
    unitConversionNote: null,
    unitConversionVerifiedAt: null,
    price: 12,
    stock: 8,
    minOrderQty: 1,
    stepQty: 1,
    shelfDays: 7,
    status: 'ENABLED',
    ...data,
  }
}

describe('internal product opening-stock warehouse writer', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId,
        userId,
        role: actorRole,
      }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    actorRole = 'SUPPLY_CHAIN'
    mocks.executeRaw.mockResolvedValue([])
    mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '测试供应商' })
    mocks.categoryFindUnique.mockResolvedValue({ isActive: true })
    mocks.warehouseFindFirst.mockResolvedValue({ id: warehouseId })
    mocks.productCreate.mockImplementation(async ({ data }: any) => createdProduct(data))
    mocks.movementCreate.mockResolvedValue({ id: movementId })
    mocks.batchCreate.mockResolvedValue({ id: 'batch-opening' })
    mocks.opLogCreate.mockResolvedValue({})
  })

  it('resolves by the authenticated tenant before writing the product and both opening facts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'OPENING-001',
        name: '期初库存商品',
        category: '蔬菜',
        unit: '箱',
        price: 12,
        stock: 8,
        supplierId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true },
    })
    expect(mocks.warehouseFindFirst.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.productCreate.mock.invocationCallOrder[0])
    expect(mocks.warehouseFindFirst.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.movementCreate.mock.invocationCallOrder[0])
    expect(mocks.movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        warehouseId,
        supplierId,
        productId,
        type: 'INITIAL',
      }),
    })
    expect(mocks.batchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        warehouseId,
        supplierId,
        productId,
        sourceMovementId: movementId,
        kind: 'OPENING',
      }),
    })
    expect(mocks.movementCreate.mock.calls[0][0].data.warehouseId).toBe(warehouseId)
    expect(mocks.batchCreate.mock.calls[0][0].data.warehouseId).toBe(warehouseId)
    expect(mocks.movementCreate.mock.calls[0][0].data.warehouseId).not.toBe('default')
    expect(mocks.batchCreate.mock.calls[0][0].data.warehouseId).not.toBe('default')
  })

  it('stops all product and opening-fact writes when the authenticated tenant has no active default warehouse', async () => {
    mocks.warehouseFindFirst.mockResolvedValue(null)

    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'OPENING-FAIL',
        name: '不应落库商品',
        category: '蔬菜',
        unit: '箱',
        stock: 8,
        supplierId,
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: '当前租户不存在启用的默认仓' })
    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true },
    })
    expect(mocks.productCreate).not.toHaveBeenCalled()
    expect(mocks.movementCreate).not.toHaveBeenCalled()
    expect(mocks.batchCreate).not.toHaveBeenCalled()
    expect(mocks.opLogCreate).not.toHaveBeenCalled()
  })

  it('preserves legacy internal admin opening-stock facts while binding them to the tenant default warehouse', async () => {
    actorRole = 'ADMIN'

    const response = await app.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        code: 'OPENING-ADMIN',
        name: '管理员期初商品',
        category: '蔬菜',
        unit: '箱',
        price: 12,
        stock: 8,
        supplierId,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true },
    })
    expect(mocks.movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId, warehouseId, supplierId, type: 'INITIAL' }),
    })
    expect(mocks.batchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId, warehouseId, supplierId, kind: 'OPENING' }),
    })
  })
})

describe('warehouse-scoped supplier batch consumption', () => {
  it('filters batch SQL and writes the allocation with the same explicit warehouse', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{
      id: 'batch-in-warehouse',
      remainingQty: new Prisma.Decimal(5),
    }])
    const batchUpdate = vi.fn().mockResolvedValue({})
    const allocationCreate = vi.fn().mockResolvedValue({})
    const tx = {
      $queryRaw: queryRaw,
      supplierStockBatch: { update: batchUpdate },
      supplierStockBatchAllocation: { create: allocationCreate },
    } as any

    await consumeSupplierStockBatches(tx, {
      tenantId,
      warehouseId,
      supplierId,
      productId,
      quantity: 3,
      movementId: 'movement-outbound',
    })

    const sql = queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(sql.strings.join('${value}')).toContain('AND "warehouseId" = ${value}')
    expect(sql.values).toContain(warehouseId)
    expect(sql.values).toEqual(expect.arrayContaining([tenantId, supplierId, productId, warehouseId]))
    expect(allocationCreate).toHaveBeenCalledWith({
      data: {
        tenantId,
        warehouseId,
        supplierId,
        productId,
        batchId: 'batch-in-warehouse',
        movementId: 'movement-outbound',
        quantity: new Prisma.Decimal(3),
      },
    })
  })
})
