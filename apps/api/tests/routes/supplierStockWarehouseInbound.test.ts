import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  warehouseFindFirst: vi.fn(),
  productFindMany: vi.fn(),
  queryRaw: vi.fn(),
  productUpdate: vi.fn(),
  warehouseStockUpdate: vi.fn(),
  movementCreate: vi.fn(),
  batchCreate: vi.fn(),
  batchFindFirst: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const txMock: any = {
    $queryRaw: (...args: any[]) => mocks.queryRaw(...args),
    product: {
      findMany: (...args: any[]) => mocks.productFindMany(...args),
      update: (...args: any[]) => mocks.productUpdate(...args),
    },
    warehouse: {
      findFirst: (...args: any[]) => mocks.warehouseFindFirst(...args),
    },
    warehouseStock: {
      update: (...args: any[]) => mocks.warehouseStockUpdate(...args),
    },
    supplierStockMovement: {
      create: (...args: any[]) => mocks.movementCreate(...args),
    },
    supplierStockBatch: {
      create: (...args: any[]) => mocks.batchCreate(...args),
      findFirst: (...args: any[]) => mocks.batchFindFirst(...args),
    },
  }
  const prismaMock: any = {
    ...txMock,
    $transaction: vi.fn(async (fn: any) => fn(txMock)),
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => any) => fn(),
  invalidatePattern: vi.fn(),
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

import { Prisma } from '@dianjie/db'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

const tenantId = 'tenant-a'
const userId = 'user-a'
const supplierId = 'supplier-a'
const realWarehouseId = 'wh-real-default'

const actor = {
  tenantId,
  userId,
  supplierId,
  role: 'SUPPLIER_OWNER',
}

function dec(value: number | string) {
  return new Prisma.Decimal(value)
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

function setupDefaults() {
  mocks.warehouseFindFirst.mockResolvedValue({ id: realWarehouseId })
  mocks.batchFindFirst.mockResolvedValue(null)
  mocks.movementCreate.mockImplementation(async ({ data }: any) => ({
    id: `mov-${data.productId}`,
    ...data,
  }))
  mocks.batchCreate.mockImplementation(async ({ data }: any) => ({
    id: `batch-${data.productId}`,
    ...data,
  }))
  mocks.productUpdate.mockResolvedValue({})
  mocks.warehouseStockUpdate.mockResolvedValue({})
}

function setupProductAndLocks(items: Array<{ id: string; stock: number; physicalQty: number }>) {
  mocks.productFindMany.mockResolvedValue(
    items.map(p => ({ id: p.id, name: `P-${p.id}`, stock: dec(p.stock) })),
  )

  const sortedIds = [...new Set(items.map(i => i.id))].sort()
  let callIndex = 0
  mocks.queryRaw.mockImplementation(async () => {
    callIndex++
    if (callIndex % 2 === 1) {
      return sortedIds.map(id => {
        const item = items.find(i => i.id === id)!
        return { id: item.id, stock: dec(item.stock) }
      })
    }
    return sortedIds.map(id => {
      const item = items.find(i => i.id === id)!
      return { productId: item.id, physicalQty: dec(item.physicalQty) }
    })
  })
}

function postInbound(app: any, payload: any, query = 'warehouseId=default') {
  return app.inject({
    method: 'POST',
    url: `/api/supplier/stock/inbound?${query}`,
    headers: { 'content-type': 'application/json' },
    payload,
  })
}

describe('POST /api/supplier/stock/inbound — warehouse-scoped writer', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaults()
  })

  afterEach(async () => {
    await app?.close()
  })

  it('resolves default alias to real warehouse and uses it throughout', async () => {
    setupProductAndLocks([{ id: 'p1', stock: 100, physicalQty: 100 }])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10 }],
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.warehouseId).toBe(realWarehouseId)
    expect(body.warehouse).toEqual({ id: realWarehouseId, name: '默认仓' })
    expect(body.items[0].warehouseId).toBe(realWarehouseId)

    const movementData = mocks.movementCreate.mock.calls[0][0].data
    expect(movementData.warehouseId).toBe(realWarehouseId)

    const batchData = mocks.batchCreate.mock.calls[0][0].data
    expect(batchData.warehouseId).toBe(realWarehouseId)
  })

  it('uses WarehouseStock.physicalQty as primary balance for balanceAfter', async () => {
    setupProductAndLocks([{ id: 'p1', stock: 100, physicalQty: 100 }])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 25 }],
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items[0].balanceAfter).toBe(125)

    const movementData = mocks.movementCreate.mock.calls[0][0].data
    expect(Number(movementData.balanceAfter)).toBe(125)
  })

  it('updates both WarehouseStock.physicalQty and Product.stock as mirror', async () => {
    setupProductAndLocks([{ id: 'p1', stock: 50, physicalQty: 50 }])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10 }],
    })

    expect(res.statusCode).toBe(200)

    expect(mocks.warehouseStockUpdate).toHaveBeenCalledTimes(1)
    const wsUpdate = mocks.warehouseStockUpdate.mock.calls[0][0]
    expect(wsUpdate.where.tenantId_warehouseId_productId).toEqual({
      tenantId,
      warehouseId: realWarehouseId,
      productId: 'p1',
    })
    expect(Number(wsUpdate.data.physicalQty)).toBe(60)

    expect(mocks.productUpdate).toHaveBeenCalledTimes(1)
    const pUpdate = mocks.productUpdate.mock.calls[0][0]
    expect(pUpdate.where.id).toBe('p1')
    expect(Number(pUpdate.data.stock)).toBe(60)
  })

  it('returns 409 when Product.stock and WarehouseStock.physicalQty drift', async () => {
    setupProductAndLocks([{ id: 'p1', stock: 100, physicalQty: 80 }])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10 }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('不一致')
    expect(mocks.productUpdate).not.toHaveBeenCalled()
    expect(mocks.warehouseStockUpdate).not.toHaveBeenCalled()
    expect(mocks.movementCreate).not.toHaveBeenCalled()
    expect(mocks.batchCreate).not.toHaveBeenCalled()
  })

  it('returns 409 when WarehouseStock row is missing', async () => {
    mocks.productFindMany.mockResolvedValue([
      { id: 'p1', name: 'P1', stock: dec(100) },
    ])
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'p1', stock: dec(100) }])
      .mockResolvedValueOnce([])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10 }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('仓库库存记录缺失')
    expect(mocks.movementCreate).not.toHaveBeenCalled()
  })

  it('returns 404 when warehouse is cross-tenant', async () => {
    mocks.warehouseFindFirst.mockResolvedValue(null)
    mocks.productFindMany.mockResolvedValue([
      { id: 'p1', name: 'P1', stock: dec(100) },
    ])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10 }],
    })

    expect(res.statusCode).toBe(404)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
    expect(mocks.movementCreate).not.toHaveBeenCalled()
  })

  it('returns 404 when tenant has no default warehouse', async () => {
    mocks.warehouseFindFirst.mockResolvedValue(null)
    mocks.productFindMany.mockResolvedValue([
      { id: 'p1', name: 'P1', stock: dec(100) },
    ])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 5 }],
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toContain('默认仓')
  })

  it('scopes batch dedup to tenant+supplier+warehouse+product', async () => {
    setupProductAndLocks([{ id: 'p1', stock: 100, physicalQty: 100 }])
    mocks.batchFindFirst.mockResolvedValue({ batchNo: 'BATCH-EXIST' })
    app = await buildApp()

    const res = await postInbound(app, {
      items: [{ productId: 'p1', qty: 10, batchNo: 'BATCH-EXIST' }],
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('批次号已存在')

    const findFirstArgs = mocks.batchFindFirst.mock.calls[0][0]
    expect(findFirstArgs.where.warehouseId).toBe(realWarehouseId)
    expect(findFirstArgs.where.tenantId).toBe(tenantId)
    expect(findFirstArgs.where.supplierId).toBe(supplierId)

    expect(mocks.movementCreate).not.toHaveBeenCalled()
  })

  it('rolls back entire batch when any item fails', async () => {
    setupProductAndLocks([
      { id: 'p-a', stock: 100, physicalQty: 100 },
      { id: 'p-b', stock: 50, physicalQty: 50 },
    ])

    let updateCount = 0
    mocks.warehouseStockUpdate.mockImplementation(async () => {
      updateCount++
      if (updateCount === 2) {
        throw Object.assign(new Error('simulated write failure'), { statusCode: 500 })
      }
      return {}
    })
    app = await buildApp()

    const res = await postInbound(app, {
      items: [
        { productId: 'p-a', qty: 10 },
        { productId: 'p-b', qty: 5 },
      ],
    })

    expect(res.statusCode).toBe(500)
  })

  it('locks products in stable sorted order', async () => {
    const items = [
      { id: 'p-c', stock: 30, physicalQty: 30 },
      { id: 'p-a', stock: 10, physicalQty: 10 },
      { id: 'p-b', stock: 20, physicalQty: 20 },
    ]
    setupProductAndLocks(items)
    app = await buildApp()

    const res = await postInbound(app, {
      items: [
        { productId: 'p-c', qty: 1 },
        { productId: 'p-a', qty: 1 },
        { productId: 'p-b', qty: 1 },
      ],
    })

    expect(res.statusCode).toBe(200)
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2)
    const warehouseSql = mocks.queryRaw.mock.calls[1][0]
    expect(warehouseSql.strings.join('${value}')).toContain('"isActive" = TRUE')
  })

  it('returns 409 with zero writes on balance drift in multi-item batch', async () => {
    setupProductAndLocks([
      { id: 'p-a', stock: 100, physicalQty: 100 },
      { id: 'p-b', stock: 50, physicalQty: 40 },
    ])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [
        { productId: 'p-a', qty: 10 },
        { productId: 'p-b', qty: 5 },
      ],
    })

    expect(res.statusCode).toBe(409)
    expect(mocks.productUpdate).not.toHaveBeenCalled()
    expect(mocks.warehouseStockUpdate).not.toHaveBeenCalled()
    expect(mocks.movementCreate).not.toHaveBeenCalled()
  })

  it('processes multi-item batch with consistent balances', async () => {
    setupProductAndLocks([
      { id: 'p-a', stock: 100, physicalQty: 100 },
      { id: 'p-b', stock: 50, physicalQty: 50 },
    ])
    app = await buildApp()

    const res = await postInbound(app, {
      items: [
        { productId: 'p-a', qty: 10 },
        { productId: 'p-b', qty: 5 },
      ],
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)
    expect(body.warehouseId).toBe(realWarehouseId)
    expect(mocks.movementCreate).toHaveBeenCalledTimes(2)
    expect(mocks.batchCreate).toHaveBeenCalledTimes(2)
    expect(mocks.warehouseStockUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.productUpdate).toHaveBeenCalledTimes(2)
  })
})
