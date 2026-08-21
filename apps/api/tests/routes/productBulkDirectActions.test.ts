import crypto from 'crypto'
import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  productFindMany: vi.fn(),
  productGroupBy: vi.fn(),
  productUpdateMany: vi.fn(),
  categoryFindMany: vi.fn(),
  categoryFindUnique: vi.fn(),
  supplierFindFirst: vi.fn(),
  opLogCreate: vi.fn(),
  documentCreate: vi.fn(),
  nextDocumentNo: vi.fn(),
  notifyProductChange: vi.fn(),
  fireAndForget: vi.fn(),
  invalidatePattern: vi.fn(),
  executeRaw: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    $transaction: (...args: any[]) => mocks.transaction(...args),
    $executeRaw: mocks.executeRaw,
    product: {
      findMany: (...args: any[]) => mocks.productFindMany(...args),
      groupBy: (...args: any[]) => mocks.productGroupBy(...args),
      updateMany: (...args: any[]) => mocks.productUpdateMany(...args),
    },
    supplierProductCategory: {
      findMany: (...args: any[]) => mocks.categoryFindMany(...args),
      findUnique: (...args: any[]) => mocks.categoryFindUnique(...args),
    },
    supplier: {
      findFirst: (...args: any[]) => mocks.supplierFindFirst(...args),
    },
    opLog: {
      create: (...args: any[]) => mocks.opLogCreate(...args),
    },
    document: {
      create: (...args: any[]) => mocks.documentCreate(...args),
    },
  }
  mocks.transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/services/notify/productChange', () => ({
  fireAndForgetNotifyProductChange: (...args: any[]) => mocks.notifyProductChange(...args),
}))

vi.mock('../../src/services/notify', () => ({
  fireAndForget: (...args: any[]) => mocks.fireAndForget(...args),
}))

vi.mock('../../src/services/documentNo', () => ({
  nextDocumentNo: (...args: any[]) => mocks.nextDocumentNo(...args),
}))

vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, fn: () => any) => fn(),
  invalidatePattern: (...args: any[]) => mocks.invalidatePattern(...args),
}))

vi.mock('../../src/services/supplierStockReservation', () => ({
  getSupplierReservedStock: vi.fn(),
  stockAvailability: vi.fn(),
}))

vi.mock('../../src/services/supplierStockBatch', () => ({
  createSupplierStockBatchIncrease: vi.fn(),
}))

vi.mock('../../src/routes/upload', () => ({
  signOssKey: vi.fn(),
}))

import { productRoutes } from '../../src/routes/products'

const tenantId = 'tenant-bulk-direct'
const supplyChainUserId = 'user-supply-chain'
const supplierUserId = 'user-supplier'
const supplierAId = 'supplier-a'
const supplierBId = 'supplier-b'

function product(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id || 'product-a',
    code: overrides.code || 'SKU-A',
    name: overrides.name || '白菜',
    category: overrides.category || '蔬菜',
    status: overrides.status || 'ENABLED',
    supplierId: overrides.supplierId || supplierAId,
    ...overrides,
  }
}

function expectedEventKey(input: {
  productId: string
  action: 'UPDATE' | 'DISABLE' | 'ENABLE'
  before: Record<string, any>
  after: Record<string, any>
}) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ before: input.before, after: input.after }))
    .digest('hex')
    .slice(0, 16)
  return `PRODUCT:${input.productId}:${input.action}:${supplyChainUserId}:${hash}`
}

describe('product bulk direct actions', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      if (request.headers['x-test-actor'] === 'supplier') {
        request.user = {
          tenantId,
          supplierId: supplierAId,
          userId: supplierUserId,
          role: 'SUPPLIER_OWNER',
        }
      } else {
        request.user = { tenantId, userId: supplyChainUserId, role: 'SUPPLY_CHAIN' }
      }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        $executeRaw: mocks.executeRaw,
        product: { updateMany: (...args: any[]) => mocks.productUpdateMany(...args) },
        supplierProductCategory: {
          findMany: (...args: any[]) => mocks.categoryFindMany(...args),
        },
        opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
        document: { create: (...args: any[]) => mocks.documentCreate(...args) },
      }
      return fn(tx)
    })
    mocks.executeRaw.mockResolvedValue([])
    mocks.productUpdateMany.mockResolvedValue({ count: 1 })
    mocks.opLogCreate.mockResolvedValue({})
    mocks.documentCreate.mockResolvedValue({})
    mocks.productGroupBy.mockResolvedValue([])
  })

  it('deduplicates ids, validates the same active category for every supplier, audits exactly and only notifies changed products', async () => {
    const changed = product()
    const unchanged = product({
      id: 'product-b',
      code: 'SKU-B',
      name: '冻豆腐',
      category: '生鲜',
      supplierId: supplierBId,
    })
    mocks.productFindMany.mockResolvedValue([changed, unchanged])
    mocks.categoryFindMany.mockResolvedValue([
      { supplierId: supplierAId },
      { supplierId: supplierBId },
    ])

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-category',
      payload: { ids: [changed.id, changed.id, unchanged.id], category: '生鲜' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, count: 1, category: '生鲜' })
    expect(mocks.productFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [changed.id, unchanged.id] }, tenantId },
    }))
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2)
    expect(mocks.productUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.productUpdateMany).toHaveBeenCalledWith({
      where: {
        id: changed.id,
        tenantId,
        supplierId: supplierAId,
        category: '蔬菜',
      },
      data: { category: '生鲜' },
    })
    expect(mocks.opLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        userId: supplyChainUserId,
        role: 'SUPPLY_CHAIN',
        entityType: 'Product',
        target: changed.code,
        targetId: changed.id,
        metadata: {
          supplierId: supplierAId,
          fields: ['category'],
          before: { name: changed.name, category: '蔬菜' },
          after: { name: changed.name, category: '生鲜' },
        },
      }),
    })

    const before = { name: changed.name, category: '蔬菜' }
    const after = { name: changed.name, category: '生鲜' }
    expect(mocks.notifyProductChange).toHaveBeenCalledTimes(1)
    expect(mocks.notifyProductChange).toHaveBeenCalledWith({
      tenantId,
      productId: changed.id,
      action: 'UPDATE',
      operatorId: supplyChainUserId,
      eventKey: expectedEventKey({ productId: changed.id, action: 'UPDATE', before, after }),
      before,
      after,
    })
  })

  it('returns only the requested same-tenant supplier category masters for internal supply chain', async () => {
    mocks.supplierFindFirst.mockResolvedValue({ id: supplierAId })
    mocks.productGroupBy.mockResolvedValue([
      { category: '生鲜', _count: { _all: 3 } },
    ])
    mocks.categoryFindMany.mockResolvedValue([
      { id: 'category-a', name: '生鲜', sortOrder: 1, isActive: true, isSystem: false },
      { id: 'category-b', name: '停用分类', sortOrder: 2, isActive: false, isSystem: false },
    ])

    const response = await app.inject({
      method: 'GET',
      url: `/api/products/categories?supplierId=${supplierAId}`,
    })

    expect(response.statusCode).toBe(200)
    expect(mocks.supplierFindFirst).toHaveBeenCalledWith({
      where: { id: supplierAId, tenantId },
      select: { id: true },
    })
    expect(mocks.productGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId, supplierId: supplierAId },
    }))
    expect(mocks.categoryFindMany).toHaveBeenCalledWith({
      where: { tenantId, supplierId: supplierAId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    expect(response.json()).toEqual([
      { id: 'category-a', name: '生鲜', count: 3, sortOrder: 1, isActive: true, isSystem: false, defaultMarkupPercent: null },
      { id: 'category-b', name: '停用分类', count: 0, sortOrder: 2, isActive: false, isSystem: false, defaultMarkupPercent: null },
    ])
  })

  it('rejects the whole category batch when any supplier lacks the same enabled category', async () => {
    const products = [
      product(),
      product({ id: 'product-b', supplierId: supplierBId }),
    ]
    mocks.productFindMany.mockResolvedValue(products)
    mocks.categoryFindMany.mockResolvedValue([{ supplierId: supplierAId }])

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-category',
      payload: { ids: products.map(item => item.id), category: '生鲜' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('每个商品所属供应商')
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.productUpdateMany).not.toHaveBeenCalled()
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })

  it('rejects the whole batch when an id is missing or outside the tenant', async () => {
    mocks.productFindMany.mockResolvedValue([product()])

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      payload: { ids: ['product-a', 'foreign-product'], status: 'DISABLED' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('不存在或无权限')
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.productUpdateMany).not.toHaveBeenCalled()
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })

  it('directly disables only changed products with exact stable notification input', async () => {
    const enabled = product()
    const disabled = product({
      id: 'product-b',
      code: 'SKU-B',
      name: '冻豆腐',
      supplierId: supplierBId,
      status: 'DISABLED',
    })
    mocks.productFindMany.mockResolvedValue([enabled, disabled])

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      payload: { ids: [enabled.id, disabled.id, enabled.id], status: 'DISABLED' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, count: 1, status: 'DISABLED' })
    expect(mocks.productUpdateMany).toHaveBeenCalledWith({
      where: { id: enabled.id, tenantId, status: 'ENABLED' },
      data: { status: 'DISABLED' },
    })
    const before = { name: enabled.name, status: 'ENABLED' }
    const after = { name: enabled.name, status: 'DISABLED' }
    expect(mocks.notifyProductChange).toHaveBeenCalledWith({
      tenantId,
      productId: enabled.id,
      action: 'DISABLE',
      operatorId: supplyChainUserId,
      eventKey: expectedEventKey({ productId: enabled.id, action: 'DISABLE', before, after }),
      before,
      after,
    })
  })

  it('directly restores disabled products and emits ENABLE after the transaction commits', async () => {
    const disabled = product({ status: 'DISABLED' })
    mocks.productFindMany.mockResolvedValue([disabled])
    const callOrder: string[] = []
    mocks.transaction.mockImplementationOnce(async (fn: any) => {
      const result = await fn({
        product: {
          updateMany: vi.fn(async () => {
            callOrder.push('update')
            return { count: 1 }
          }),
        },
        opLog: {
          create: vi.fn(async () => {
            callOrder.push('audit')
            return {}
          }),
        },
      })
      callOrder.push('commit')
      return result
    })
    mocks.notifyProductChange.mockImplementation(() => callOrder.push('notify'))

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      payload: { ids: [disabled.id], status: 'ENABLED' },
    })

    expect(response.statusCode).toBe(200)
    expect(callOrder).toEqual(['update', 'audit', 'commit', 'notify'])
    expect(mocks.notifyProductChange).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      productId: disabled.id,
      action: 'ENABLE',
      before: { name: disabled.name, status: 'DISABLED' },
      after: { name: disabled.name, status: 'ENABLED' },
    }))
  })

  it('treats a no-change replay as a no-op without audit or duplicate notification', async () => {
    mocks.productFindMany.mockResolvedValue([product({ status: 'DISABLED' })])

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      payload: { ids: ['product-a', 'product-a'], status: 'DISABLED' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      count: 0,
      status: 'DISABLED',
      message: '商品已是目标状态',
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.opLogCreate).not.toHaveBeenCalled()
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })

  it('does not notify when the direct-write transaction fails', async () => {
    mocks.productFindMany.mockResolvedValue([product()])
    mocks.transaction.mockRejectedValueOnce(new Error('test-only transaction failure'))

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      payload: { ids: ['product-a'], status: 'DISABLED' },
    })

    expect(response.statusCode).toBe(500)
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
    expect(mocks.invalidatePattern).not.toHaveBeenCalled()
  })

  it('keeps external supplier batch disable on the chef approval path', async () => {
    const enabled = product()
    mocks.productFindMany.mockResolvedValue([enabled])
    mocks.supplierFindFirst.mockResolvedValue({ name: '外部供应商 A' })
    mocks.nextDocumentNo.mockResolvedValue('DOC-BULK-1')
    mocks.documentCreate.mockResolvedValue({ no: 'DOC-BULK-1' })

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/products/batch-status',
      headers: { 'x-test-actor': 'supplier' },
      payload: { ids: [enabled.id], status: 'DISABLED' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      count: 1,
      statusChange: 'PENDING_APPROVAL',
      documentNo: 'DOC-BULK-1',
    })
    expect(mocks.productUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'PENDING_DISABLE' },
    }))
    expect(mocks.documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId,
        type: 'SUPPLIER_OFFER_DISABLE',
        initiatorId: supplierUserId,
        status: 'PENDING',
      }),
    })
    expect(mocks.notifyProductChange).not.toHaveBeenCalled()
  })
})
