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
  $queryRaw: ReturnType<typeof vi.fn>
  product: { update: ReturnType<typeof vi.fn> }
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
  const movementId = opts.movementId ?? 'mov-001'
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
    $queryRaw,
    product: { update: vi.fn(async () => ({ id: 'p1' })) },
    warehouseStock: { update: vi.fn(async () => ({ id: 'ws1' })) },
    supplierStockMovement: { create: vi.fn(async () => ({ id: movementId })) },
    supplierStockReservation: {
      aggregate: vi.fn(async () => ({ _sum: { quantity: reserved } })),
    },
    supplierStockBatch: {
      create: vi.fn(async () => ({ id: 'batch-001' })),
      update: vi.fn(async () => ({ id: 'batch-001' })),
      findFirst: vi.fn(async () => null),
    },
    supplierStockBatchAllocation: { create: vi.fn(async () => ({ id: 'alloc-001' })) },
  }
}

function mockTransaction(tx: MockTx) {
  return vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
    return callback(tx)
  })
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

describe('POST /api/supplier/stock/adjust — real warehouse', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves default warehouse alias and uses WarehouseStock.physicalQty as base', async () => {
    const whSpy = mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 120, reason: '盘盈' },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.warehouseId).toBe(REAL_WH)
      expect(json.warehouse).toEqual({ id: REAL_WH, name: '默认仓' })
      expect(json.delta).toBe(20)
      expect(json.balanceAfter).toBe(120)

      expect(whSpy).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', isDefault: true, isActive: true }),
      }))

      expect(tx.warehouseStock.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId_warehouseId_productId: { tenantId: 'tenant-a', warehouseId: REAL_WH, productId: 'p1' } },
        data: { physicalQty: new Prisma.Decimal(120) },
      }))
      expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'p1' },
        data: { stock: new Prisma.Decimal(120) },
      }))
      expect(tx.supplierStockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          supplierId: 'supplier-a',
          productId: 'p1',
          type: 'ADJUSTMENT',
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

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 70, reason: '盘亏' },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.delta).toBe(-30)
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

  it('no-change adjustment still resolves warehouse and checks consistency but writes nothing', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 100, reason: '复核' },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.ok).toBe(true)
      expect(json.unchanged).toBeUndefined()
      expect(json.message).toBe('库存无变化')
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

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 90, reason: '测试漂移' },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('不一致')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
      expect(tx.supplierStockMovement.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 404 when the tenant has no active default warehouse', async () => {
    mockWarehouseNotFound()

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 50, reason: '测试缺仓' },
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
        url: '/api/supplier/stock/adjust?warehouseId=some-other-warehouse',
        payload: { productId: 'p1', newQty: 50, reason: '测试跨仓' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toContain('未知仓库')
    } finally {
      await app.close()
    }
  })

  it('returns 409 when adjustment would go below active reservations', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      reserved: new Prisma.Decimal(60),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 50, reason: '低于预占' },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('预占')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('scopes reservation check to the real warehouse', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 120, reason: '验证预占范围' },
      })

      expect(tx.supplierStockReservation.aggregate).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          supplierId: 'supplier-a',
          warehouseId: REAL_WH,
          productId: 'p1',
          status: 'ACTIVE',
        }),
      }))
    } finally {
      await app.close()
    }
  })
})

describe('POST /api/supplier/stock/loss — real warehouse', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses WarehouseStock.physicalQty as base and writes to real warehouse', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      batchRows: [{ id: 'batch-fefo', remainingQty: new Prisma.Decimal(100) }],
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 10, reason: '过期报损' },
      })

      expect(res.statusCode).toBe(200)
      const json = res.json()
      expect(json.ok).toBe(true)
      expect(json.balanceAfter).toBe(90)
      expect(json.warehouseId).toBe(REAL_WH)
      expect(json.warehouse).toEqual({ id: REAL_WH, name: '默认仓' })

      expect(tx.warehouseStock.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId_warehouseId_productId: { tenantId: 'tenant-a', warehouseId: REAL_WH, productId: 'p1' } },
        data: { physicalQty: new Prisma.Decimal(90) },
      }))
      expect(tx.product.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'p1' },
        data: { stock: new Prisma.Decimal(90) },
      }))
      expect(tx.supplierStockMovement.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          supplierId: 'supplier-a',
          type: 'LOSS',
        }),
      }))
      expect(tx.supplierStockBatchAllocation.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          warehouseId: REAL_WH,
          batchId: 'batch-fefo',
        }),
      }))
    } finally {
      await app.close()
    }
  })

  it('returns 409 when loss quantity exceeds physicalQty', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 200, reason: '超量报损' },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('超过当前库存')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 409 when Product.stock and WarehouseStock.physicalQty drift', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(50),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 5, reason: '漂移测试' },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('不一致')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.supplierStockMovement.create).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 404 when the tenant has no active default warehouse', async () => {
    mockWarehouseNotFound()

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 5, reason: '缺仓报损' },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json().error).toContain('默认仓')
    } finally {
      await app.close()
    }
  })

  it('returns 409 when loss would go below active reservations', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      reserved: new Prisma.Decimal(95),
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 10, reason: '预占冲突' },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('占用')

      expect(tx.product.update).not.toHaveBeenCalled()
      expect(tx.warehouseStock.update).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('scopes reservation check to the real warehouse', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      batchRows: [{ id: 'batch-1', remainingQty: new Prisma.Decimal(100) }],
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 5, reason: '验证预占范围' },
      })

      expect(tx.supplierStockReservation.aggregate).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          supplierId: 'supplier-a',
          warehouseId: REAL_WH,
          productId: 'p1',
          status: 'ACTIVE',
        }),
      }))
    } finally {
      await app.close()
    }
  })

  it('consumes batches scoped to the real warehouse', async () => {
    mockWarehouseResolution()
    const tx = createMockTx({
      productStock: new Prisma.Decimal(100),
      physicalQty: new Prisma.Decimal(100),
      batchRows: [{ id: 'batch-wh', remainingQty: new Prisma.Decimal(100) }],
    })
    mockTransaction(tx)

    const app = await buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 10, reason: '验证批次范围' },
      })

      const queryRawCalls = tx.$queryRaw.mock.calls
      expect(queryRawCalls.length).toBeGreaterThanOrEqual(3)
    } finally {
      await app.close()
    }
  })
})

describe('cross-tenant warehouse isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adjust fails closed when warehouse belongs to another tenant', async () => {
    mockWarehouseNotFound()

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/adjust',
        payload: { productId: 'p1', newQty: 50, reason: '跨租户' },
      })

      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('loss fails closed when warehouse belongs to another tenant', async () => {
    mockWarehouseNotFound()

    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/supplier/stock/loss',
        payload: { productId: 'p1', qty: 5, reason: '跨租户' },
      })

      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
