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

const REAL_WH = 'wh-a-real-default'

function mockWarehouseResolution(warehouseId: string = REAL_WH) {
  return vi.spyOn(prisma.warehouse, 'findFirst').mockResolvedValue({ id: warehouseId } as any)
}

function mockWarehouseNotFound() {
  return vi.spyOn(prisma.warehouse, 'findFirst').mockResolvedValue(null)
}

type MockTx = {
  $executeRaw: ReturnType<typeof vi.fn>
  $queryRaw: ReturnType<typeof vi.fn>
  product: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  warehouseStock: { update: ReturnType<typeof vi.fn> }
  supplierStockMovement: { create: ReturnType<typeof vi.fn> }
  supplierStockReservation: { aggregate: ReturnType<typeof vi.fn> }
  supplierStockBatch: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  supplierStockBatchAllocation: { create: ReturnType<typeof vi.fn> }
}

function createMockTx(opts: {
  productStock?: Prisma.Decimal
  physicalQty?: Prisma.Decimal
  reserved?: Prisma.Decimal
  movementId?: string
  batchRows?: Array<{ id: string; remainingQty: Prisma.Decimal }>
} = {}): MockTx {
  const productStock = opts.productStock ?? new Prisma.Decimal(100)
  const physicalQty = opts.physicalQty ?? new Prisma.Decimal(100)
  const reserved = opts.reserved ?? new Prisma.Decimal(0)
  const movementId = opts.movementId ?? 'mov-snap-001'
  const batchRows = opts.batchRows

  let queryRawCallIndex = 0
  const $queryRaw = vi.fn(async () => {
    const callIdx = queryRawCallIndex++
    if (callIdx === 0) {
      return [{ id: 'p1', stock: productStock }]
    }
    if (callIdx === 1) {
      return [{ productId: 'p1', physicalQty }]
    }
    if (batchRows && callIdx >= 2) {
      return batchRows
    }
    return []
  })

  return {
    $executeRaw: vi.fn(async () => undefined),
    $queryRaw,
    product: {
      findMany: vi.fn(async () => [{ id: 'p1', name: '土豆', tenantId: 'tenant-a', supplierId: 'supplier-a' }]),
      update: vi.fn(async () => ({ id: 'p1' })),
    },
    warehouseStock: { update: vi.fn(async () => ({ id: 'ws1' })) },
    supplierStockMovement: { create: vi.fn(async () => ({ id: movementId })) },
    supplierStockReservation: {
      aggregate: vi.fn(async () => ({ _sum: { quantity: reserved } })),
    },
    supplierStockBatch: {
      create: vi.fn(async () => ({ id: 'batch-snap-001' })),
      update: vi.fn(async () => ({ id: 'batch-snap-001' })),
      findFirst: vi.fn(async () => null),
    },
    supplierStockBatchAllocation: { create: vi.fn(async () => ({ id: 'alloc-snap-001' })) },
  }
}

function mockTransaction(tx: MockTx) {
  return vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
    return callback(tx)
  })
}

function mockPreCheckProduct(names: string[]) {
  return vi.spyOn(prisma.product, 'findMany').mockResolvedValue(
    names.map(name => ({ name })) as any,
  )
}

async function buildApp() {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = actor
  })
  await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
  await app.ready()
  return app
}

describe('POST /api/supplier/stock/import-snapshot — real warehouse', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves default warehouse and uses WarehouseStock.physicalQty as snapshot base', async () => {
    const whSpy = mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(50),
      physicalQty: new Prisma.Decimal(50),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 80 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.ok).toBe(true)
      expect(json.warehouseId).toBe(REAL_WH)
      expect(json.warehouse).toEqual({ id: REAL_WH, name: '默认仓' })
      expect(json.summary.adjusted).toBe(1)

      expect(whSpy).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', isDefault: true, isActive: true }),
      }))

      expect(tx.warehouseStock.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId_warehouseId_productId: { tenantId: 'tenant-a', warehouseId: REAL_WH, productId: 'p1' } },
        data: { physicalQty: new Prisma.Decimal(80) },
      }))
      expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'p1' },
        data: { stock: new Prisma.Decimal(80) },
      }))
      expect(tx.supplierStockReservation.aggregate).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          supplierId: 'supplier-a',
          productId: 'p1',
          status: 'ACTIVE',
        }),
      }))
      expect(tx.supplierStockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          supplierId: 'supplier-a',
          productId: 'p1',
          type: 'ADJUSTMENT',
          sourceType: 'Snapshot',
          delta: new Prisma.Decimal(30),
          balanceAfter: new Prisma.Decimal(80),
        }),
      }))
      expect(tx.supplierStockBatch.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          supplierId: 'supplier-a',
          kind: 'ADJUSTMENT',
        }),
      }))
    } finally {
      await app.close()
    }
  })

  it('negative adjustment consumes batches from the real warehouse via FEFO', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      batchRows: [{ id: 'batch-old', remainingQty: new Prisma.Decimal(50) }],
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 70 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.summary.adjusted).toBe(1)
      expect(json.warehouseId).toBe(REAL_WH)

      expect(tx.supplierStockBatch.update).toHaveBeenCalled()
      expect(tx.supplierStockBatchAllocation.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          batchId: 'batch-old',
        }),
      }))
      expect(tx.supplierStockBatch.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('no-change row still resolves warehouse, checks consistency, but writes nothing', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 100 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.ok).toBe(true)
      expect(json.summary.skipped).toBe(1)
      expect(json.summary.adjusted).toBe(0)
      expect(json.warehouseId).toBe(REAL_WH)
      expect(json.warehouse).toEqual({ id: REAL_WH, name: '默认仓' })

      expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.supplierStockMovement.create).not.toHaveBeenCalled()
      expect(tx.supplierStockBatch.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 409 when Product.stock and WarehouseStock.physicalQty drift', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(80),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 90 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.summary.failed).toBe(1)
      expect(json.details.failed[0].error).toContain('不一致')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
      expect(tx.supplierStockMovement.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 404 when the tenant has no active default warehouse', async () => {
    mockWarehouseNotFound()
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 50 }] },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json().error).toContain('默认仓')
    } finally {
      await app.close()
    }
  })

  it('rejects non-default warehouseId at the preHandler gate', async () => {
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot?warehouseId=wh-other-tenant',
        payload: { items: [{ name: '土豆', qty: 50 }] },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toContain('未知仓库')
    } finally {
      await app.close()
    }
  })

  it('returns 409 when snapshot target would go below active reservations', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      reserved: new Prisma.Decimal(60),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 30 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.summary.failed).toBe(1)
      expect(json.details.failed[0].error).toContain('预占')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('failed row does not affect other rows and produces zero writes for that row', async () => {
    mockWarehouseResolution()

    const txGood = createMockTx({
      productStock: new Prisma.Decimal(50),
      physicalQty: new Prisma.Decimal(50),
    })
    const txBad = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(80),
    })

    let txCallCount = 0
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const idx = txCallCount++
      return callback(idx === 0 ? txBad : txGood)
    })

    const productFindMany = vi.spyOn(prisma.product, 'findMany')
    productFindMany.mockResolvedValueOnce([{ name: '漂移品' }, { name: '正常品' }] as any)
    productFindMany.mockImplementation(async (args: any) => {
      const name = args?.where?.name
      if (name === '漂移品') return [{ id: 'p-bad', name: '漂移品' }]
      if (name === '正常品') return [{ id: 'p-good', name: '正常品' }]
      return []
    })

    let queryRawCallIndex = 0
    txBad.$queryRaw.mockImplementation(async () => {
      const callIdx = queryRawCallIndex++
      if (callIdx === 0) return [{ id: 'p-bad', stock: new Prisma.Decimal(100) }]
      if (callIdx === 1) return [{ productId: 'p-bad', physicalQty: new Prisma.Decimal(80) }]
      return []
    })

    let queryRawCallIndexGood = 0
    txGood.$queryRaw.mockImplementation(async () => {
      const callIdx = queryRawCallIndexGood++
      if (callIdx === 0) return [{ id: 'p-good', stock: new Prisma.Decimal(50) }]
      if (callIdx === 1) return [{ productId: 'p-good', physicalQty: new Prisma.Decimal(50) }]
      return []
    })

    txGood.product.findMany.mockResolvedValue([{ id: 'p-good', name: '正常品' }])
    txBad.product.findMany.mockResolvedValue([{ id: 'p-bad', name: '漂移品' }])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '漂移品', qty: 90 }, { name: '正常品', qty: 80 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.summary.failed).toBe(1)
      expect(json.summary.adjusted).toBe(1)
      expect(json.details.failed[0].name).toBe('漂移品')
      expect(json.details.adjusted[0].name).toBe('正常品')

      expect(txBad.product.update).not.toHaveBeenCalled()
      expect(txBad.warehouseStock.update).not.toHaveBeenCalled()
      expect(txGood.product.update).toHaveBeenCalled()
      expect(txGood.warehouseStock.update).toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('response warehouseId and warehouse.id are the real warehouse ID', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(50),
      physicalQty: new Prisma.Decimal(50),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 80 }] },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.warehouseId).toBe(REAL_WH)
      expect(json.warehouse.id).toBe(REAL_WH)
      expect(json.warehouse.name).toBe('默认仓')
    } finally {
      await app.close()
    }
  })

  it('movement and batch carry the real warehouseId on positive adjustment', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(50),
      physicalQty: new Prisma.Decimal(50),
    })
    mockTransaction(tx)
    mockPreCheckProduct(['土豆'])

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/import-snapshot',
        payload: { items: [{ name: '土豆', qty: 80 }] },
      })

      expect(res.statusCode).toBe(200)

      const movementData = tx.supplierStockMovement.create.mock.calls[0][0].data
      expect(movementData.warehouseId).toBe(REAL_WH)
      expect(movementData.supplierId).toBe('supplier-a')

      const batchData = tx.supplierStockBatch.create.mock.calls[0][0].data
      expect(batchData.warehouseId).toBe(REAL_WH)
      expect(batchData.supplierId).toBe('supplier-a')
    } finally {
      await app.close()
    }
  })
})
