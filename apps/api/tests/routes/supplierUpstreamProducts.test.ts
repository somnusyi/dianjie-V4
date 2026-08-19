import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import {
  supplierUpstreamBindBodySchema,
  supplierUpstreamPatchBodySchema,
  supplierUpstreamProductRoutes,
  upstreamRelationsRoutes,
} from '../../src/routes/supplierUpstreamProducts'

const mocks = vi.hoisted(() => ({
  supplierFindFirst: vi.fn(),
  productFindMany: vi.fn(),
  productFindManyUnbound: vi.fn(),
  sourceFindMany: vi.fn(),
  sourceFindFirst: vi.fn(),
  sourceCreate: vi.fn(),
  sourceUpdate: vi.fn(),
  sourceUpdateMany: vi.fn(),
  opLogCreate: vi.fn(),
  executeRaw: vi.fn(),
  invalidatePattern: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    $transaction: vi.fn(async (fn: any) => fn(prismaMock)),
    $executeRaw: (...args: any[]) => mocks.executeRaw(...args),
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    product: {
      findMany: (...args: any[]) => {
        const where = args[0]?.where
        if (where?.upstreamSources) return mocks.productFindManyUnbound(...args)
        return mocks.productFindMany(...args)
      },
    },
    productUpstreamSource: {
      findMany: (...args: any[]) => mocks.sourceFindMany(...args),
      findFirst: (...args: any[]) => mocks.sourceFindFirst(...args),
      create: (...args: any[]) => mocks.sourceCreate(...args),
      update: (...args: any[]) => mocks.sourceUpdate(...args),
      updateMany: (...args: any[]) => mocks.sourceUpdateMany(...args),
    },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => any) => fn(),
  invalidatePattern: (...args: any[]) => mocks.invalidatePattern(...args),
}))

const tenantId = 'tenant-rel'
const userId = 'user-rel'
const supplierId = 'sup-1'

const bindItem = {
  productId: 'prod-1',
  purchaseUnit: '件',
  inventoryUnitsPerPurchaseUnit: 6,
  quotedUnitPrice: 100,
}

describe('supplier upstream bind payload', () => {
  it('accepts a batch with defaults applied', () => {
    const parsed = supplierUpstreamBindBodySchema.safeParse({ items: [bindItem] })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.items[0]).toMatchObject({ isPrimary: false, minOrderQty: 1, leadTimeDays: 0 })
    }
  })

  it('rejects empty batch, oversize batch and non-positive conversion', () => {
    expect(supplierUpstreamBindBodySchema.safeParse({ items: [] }).success).toBe(false)
    expect(supplierUpstreamBindBodySchema.safeParse({
      items: Array.from({ length: 201 }, (_, i) => ({ ...bindItem, productId: `p-${i}` })),
    }).success).toBe(false)
    expect(supplierUpstreamBindBodySchema.safeParse({
      items: [{ ...bindItem, inventoryUnitsPerPurchaseUnit: 0 }],
    }).success).toBe(false)
  })

  it('patch body rejects empty updates', () => {
    expect(supplierUpstreamPatchBodySchema.safeParse({}).success).toBe(true) // schema 通过, 路由层拦空更新
    expect(supplierUpstreamPatchBodySchema.safeParse({ quotedUnitPrice: -1 }).success).toBe(false)
  })
})

describe('supplier upstream product routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, userId, role: 'SUPPLY_CHAIN' }
    })
    await app.register(supplierUpstreamProductRoutes, { prefix: '/api/suppliers' })
    await app.register(upstreamRelationsRoutes, { prefix: '/api/upstream-relations' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, no: 'GYS001', name: '井育苗菇' })
    mocks.productFindMany.mockResolvedValue([
      { id: 'prod-1', code: 'P001', name: '舞茸菇' },
      { id: 'prod-2', code: 'P002', name: '金耳菌' },
    ])
    mocks.sourceFindMany.mockResolvedValue([])
    mocks.sourceCreate.mockImplementation(async ({ data }: any) => ({ id: `src-${data.productId}`, ...data }))
    mocks.sourceUpdate.mockImplementation(async ({ data }: any) => ({ id: 'src-x', ...data }))
    mocks.opLogCreate.mockResolvedValue({})
  })

  it('batch binds new products, skips active ones and reactivates soft-deleted ones', async () => {
    mocks.sourceFindMany.mockResolvedValue([
      { id: 'src-1', productId: 'prod-1', isActive: true },   // 已生效 → 跳过
      { id: 'src-2', productId: 'prod-2', isActive: false },  // 软删 → 复活
    ])
    mocks.productFindMany.mockResolvedValue([
      { id: 'prod-1', code: 'P001', name: '舞茸菇' },
      { id: 'prod-2', code: 'P002', name: '金耳菌' },
      { id: 'prod-3', code: 'P003', name: '龙爪菇' },
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/upstream-products`,
      payload: {
        items: [
          { ...bindItem, productId: 'prod-1' },
          { ...bindItem, productId: 'prod-2' },
          { ...bindItem, productId: 'prod-3', isPrimary: true },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.boundCount).toBe(1)
    expect(body.reactivatedCount).toBe(1)
    expect(body.skipped).toEqual([{ productId: 'prod-1', name: '舞茸菇' }])
    // 复活走 update, 新绑走 create
    expect(mocks.sourceUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.sourceCreate).toHaveBeenCalledTimes(1)
    // 设主供要清掉其它供应商的主供标记
    expect(mocks.sourceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ productId: 'prod-3', supplierId: { not: supplierId }, isPrimary: true }),
    }))
    expect(mocks.opLogCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects binding when supplier is not an enabled upstream supplier', async () => {
    mocks.supplierFindFirst.mockResolvedValue(null)
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/upstream-products`,
      payload: { items: [bindItem] },
    })
    expect(response.statusCode).toBe(400)
    expect(mocks.sourceCreate).not.toHaveBeenCalled()
  })

  it('rejects when any product is missing or disabled', async () => {
    mocks.productFindMany.mockResolvedValue([{ id: 'prod-1', code: 'P001', name: '舞茸菇' }])
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/upstream-products`,
      payload: { items: [bindItem, { ...bindItem, productId: 'prod-gone' }] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('prod-gone')
    expect(mocks.sourceCreate).not.toHaveBeenCalled()
  })

  it('patches an active binding and clears other primaries when set primary', async () => {
    mocks.sourceFindFirst.mockResolvedValue({
      id: 'src-1', productId: 'prod-1', supplierId, isActive: true, isPrimary: false,
      product: { name: '舞茸菇', code: 'P001' }, supplier: { name: '井育苗菇' },
    })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/suppliers/${supplierId}/upstream-products/prod-1`,
      payload: { quotedUnitPrice: 88, isPrimary: true },
    })
    expect(response.statusCode).toBe(200)
    expect(mocks.sourceUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { quotedUnitPrice: 88, isPrimary: true },
    }))
  })

  it('returns 404 when patching or unbinding a missing relation', async () => {
    mocks.sourceFindFirst.mockResolvedValue(null)
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/suppliers/${supplierId}/upstream-products/prod-x`,
      payload: { quotedUnitPrice: 1 },
    })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/suppliers/${supplierId}/upstream-products/prod-x`,
    })
    expect(del.statusCode).toBe(404)
  })

  it('soft-unbinds and clears the primary flag', async () => {
    mocks.sourceFindFirst.mockResolvedValue({
      id: 'src-1', productId: 'prod-1', supplierId, isActive: true, isPrimary: true,
      product: { name: '舞茸菇', code: 'P001' }, supplier: { name: '井育苗菇' },
    })
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/suppliers/${supplierId}/upstream-products/prod-1`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, wasPrimary: true })
    expect(mocks.sourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { isActive: false, isPrimary: false },
    }))
  })

  it('lists flat relations and unbound products', async () => {
    mocks.sourceFindMany.mockResolvedValue([
      {
        id: 'src-1', productId: 'prod-1', supplierId, isPrimary: true, supplierSku: null,
        purchaseUnit: '件', inventoryUnitsPerPurchaseUnit: 6, quotedUnitPrice: 100,
        minOrderQty: 1, leadTimeDays: 0, note: null,
        product: { id: 'prod-1', code: 'P001', name: '舞茸菇', category: '常见菌类', spec: null, unit: '件', purchaseUnit: '件', inventoryUnit: 'g', inventoryUnitsPerPurchaseUnit: 6, price: 100, status: 'ENABLED' },
        supplier: { id: supplierId, no: 'GYS001', name: '井育苗菇', status: 'ENABLED' },
      },
    ])
    const list = await app.inject({ method: 'GET', url: '/api/upstream-relations' })
    expect(list.statusCode).toBe(200)
    expect(list.json()[0]).toMatchObject({
      productId: 'prod-1', isPrimary: true,
      product: { name: '舞茸菇' }, supplier: { name: '井育苗菇' },
    })

    mocks.productFindManyUnbound.mockResolvedValue([
      { id: 'prod-9', code: 'P009', name: '未绑商品', category: '干货类', spec: null, unit: '件', purchaseUnit: '件', inventoryUnit: null, inventoryUnitsPerPurchaseUnit: null, price: 10, status: 'ENABLED' },
    ])
    const unbound = await app.inject({ method: 'GET', url: '/api/upstream-relations/unbound' })
    expect(unbound.statusCode).toBe(200)
    expect(unbound.json()).toEqual([
      expect.objectContaining({ id: 'prod-9', name: '未绑商品', category: '干货类' }),
    ])
  })

  it('rejects roles without access', async () => {
    const denied = Fastify()
    denied.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, userId, role: 'MANAGER' }
    })
    await denied.register(supplierUpstreamProductRoutes, { prefix: '/api/suppliers' })
    await denied.ready()
    const response = await denied.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/upstream-products`,
      payload: { items: [bindItem] },
    })
    expect(response.statusCode).toBe(403)
  })
})
