import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  qualityFindMany: vi.fn(),
  qualityFindFirst: vi.fn(),
  qualityUpdateMany: vi.fn(),
  qualityCreate: vi.fn(),
  priceFindMany: vi.fn(),
  priceFindFirst: vi.fn(),
  priceUpdateMany: vi.fn(),
  priceCreate: vi.fn(),
  productFindFirst: vi.fn(),
  supplierFindFirst: vi.fn(),
  sourceFindFirst: vi.fn(),
  opLogCreate: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const tx = {
    $queryRaw: (...args: any[]) => mocks.queryRaw(...args),
    productQualityStandard: {
      findFirst: (...args: any[]) => mocks.qualityFindFirst(...args),
      updateMany: (...args: any[]) => mocks.qualityUpdateMany(...args),
      create: (...args: any[]) => mocks.qualityCreate(...args),
    },
    productPurchasePriceStandard: {
      findFirst: (...args: any[]) => mocks.priceFindFirst(...args),
      updateMany: (...args: any[]) => mocks.priceUpdateMany(...args),
      create: (...args: any[]) => mocks.priceCreate(...args),
    },
    product: { findFirst: (...args: any[]) => mocks.productFindFirst(...args) },
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    productUpstreamSource: { findFirst: (...args: any[]) => mocks.sourceFindFirst(...args) },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
  }
  return {
    ...actual,
    prisma: {
      user: { findFirst: (...args: any[]) => mocks.userFindFirst(...args) },
      productQualityStandard: { findMany: (...args: any[]) => mocks.qualityFindMany(...args) },
      productPurchasePriceStandard: { findMany: (...args: any[]) => mocks.priceFindMany(...args) },
      $transaction: (...args: any[]) => mocks.transaction(...args),
    },
    __standardTx: tx,
  }
})

import { standardReplacementArchiveRequestKey, upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

const actor = { id: 'user-1', name: '采购员甲', role: 'SUPPLY_CHAIN' }
const commonRecord = {
  tenantId: 'tenant-1',
  active: true,
  effectiveAt: new Date('2026-09-28T00:00:00.000Z'),
  createdById: actor.id,
  createdByNameSnapshot: actor.name,
  createdByRoleSnapshot: actor.role,
  createdAt: new Date('2026-09-28T01:00:00.000Z'),
  archivedAt: null,
  archivedById: null,
  archivedByNameSnapshot: null,
  archivedByRoleSnapshot: null,
  archiveRequestKey: null,
  archiveRequestFingerprint: null,
}

describe('purchase price and quality standards routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId: 'tenant-1', userId: 'user-1', role: request.headers['x-test-role'] || 'SUPPLY_CHAIN' }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    const { __standardTx } = await import('@dianjie/db') as any
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback(__standardTx))
    mocks.userFindFirst.mockResolvedValue(actor)
    mocks.queryRaw.mockResolvedValue([{ locked: '1' }])
    mocks.productFindFirst.mockResolvedValue({ id: 'product-1', name: '羊肚菌' })
    mocks.supplierFindFirst.mockResolvedValue({ id: 'supplier-1', name: '云南供应商' })
    mocks.sourceFindFirst.mockResolvedValue({ id: 'source-1' })
    mocks.qualityFindFirst.mockResolvedValue(null)
    mocks.priceFindFirst.mockResolvedValue(null)
    mocks.qualityUpdateMany.mockResolvedValue({ count: 0 })
    mocks.priceUpdateMany.mockResolvedValue({ count: 0 })
    mocks.opLogCreate.mockResolvedValue({ id: 'log-1' })
  })

  it('uses distinct bounded archive keys when identical content is resubmitted with a new request key', () => {
    const first = standardReplacementArchiveRequestKey('quality', 'request-key-one', 'same-content-fingerprint')
    const second = standardReplacementArchiveRequestKey('quality', 'request-key-two', 'same-content-fingerprint')

    expect(first).not.toBe(second)
    expect(first.length).toBeLessThanOrEqual(160)
    expect(second.length).toBeLessThanOrEqual(160)
  })

  it('lists only tenant-scoped active standards by default and hides idempotency internals', async () => {
    mocks.qualityFindMany.mockResolvedValue([{
      ...commonRecord,
      id: 'quality-1', productId: 'product-1', version: 2,
      title: '鲜品验收', criteria: { 色泽: '正常' },
      requestKey: 'private-key', requestFingerprint: 'private-fingerprint',
      product: { id: 'product-1', code: 'P001', name: '羊肚菌', spec: '1kg' },
    }])

    const response = await app.inject({ method: 'GET', url: '/api/upstream/quality-standards' })

    expect(response.statusCode).toBe(200)
    expect(mocks.qualityFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-1', active: true },
    }))
    expect(response.json()[0]).toMatchObject({ id: 'quality-1', productId: 'product-1', version: 2, createdByName: '采购员甲' })
    expect(response.json()[0]).not.toHaveProperty('tenantId')
    expect(response.json()[0]).not.toHaveProperty('requestKey')
    expect(response.json()[0]).not.toHaveProperty('requestFingerprint')
    expect(response.json()[0]).not.toHaveProperty('createdById')
  })

  it('creates a quality-standard version and audits the actor snapshot', async () => {
    mocks.qualityFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ version: 2 })
    mocks.qualityCreate.mockImplementation(async ({ data }: any) => ({
      ...commonRecord, ...data, id: 'quality-3', createdAt: commonRecord.createdAt,
    }))

    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/quality-standards',
      payload: {
        productId: 'product-1', title: '鲜品验收', criteria: { 色泽: '正常', 异味: '无' },
        effectiveAt: '2026-09-28T00:00:00.000Z', requestKey: 'quality-request-0001',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.qualityCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: 'tenant-1', productId: 'product-1', version: 3,
      createdById: 'user-1', createdByNameSnapshot: '采购员甲', createdByRoleSnapshot: 'SUPPLY_CHAIN',
    }) })
    expect(mocks.opLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: '更新商品质量验收标准', entityType: 'ProductQualityStandard', targetId: 'quality-3',
    }) })
    expect(response.json()).not.toHaveProperty('requestKey')
  })

  it('replays the same quality-standard request without creating another version', async () => {
    const replay = {
      ...commonRecord,
      id: 'quality-1', productId: 'product-1', version: 1,
      title: '鲜品验收', criteria: { 色泽: '正常' },
      requestKey: 'quality-request-0002',
      requestFingerprint: expect.any(String),
    }
    // Capture the server-generated fingerprint once, then use it as the persisted value.
    mocks.qualityFindFirst.mockImplementationOnce(async () => null)
    mocks.qualityFindFirst.mockImplementationOnce(async () => ({ version: 0 }))
    mocks.qualityCreate.mockImplementationOnce(async ({ data }: any) => ({ ...replay, ...data }))
    const payload = {
      productId: 'product-1', title: '鲜品验收', criteria: { 色泽: '正常' },
      effectiveAt: '2026-09-28T00:00:00.000Z', requestKey: 'quality-request-0002',
    }
    const first = await app.inject({ method: 'POST', url: '/api/upstream/quality-standards', payload })
    expect(first.statusCode).toBe(201)
    const persistedFingerprint = mocks.qualityCreate.mock.calls[0][0].data.requestFingerprint
    vi.clearAllMocks()
    mocks.userFindFirst.mockResolvedValue(actor)
    mocks.queryRaw.mockResolvedValue([{ locked: '1' }])
    const { __standardTx } = await import('@dianjie/db') as any
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback(__standardTx))
    mocks.qualityFindFirst.mockResolvedValue({ ...replay, requestFingerprint: persistedFingerprint })

    const second = await app.inject({ method: 'POST', url: '/api/upstream/quality-standards', payload })

    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ id: 'quality-1', version: 1 })
    expect(mocks.qualityCreate).not.toHaveBeenCalled()
    expect(mocks.opLogCreate).not.toHaveBeenCalled()
  })

  it('rejects a price standard when no matching active supplier-product-unit source exists', async () => {
    mocks.sourceFindFirst.mockResolvedValue(null)

    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/price-standards',
      payload: {
        productId: 'product-1', supplierId: 'supplier-1', purchaseUnit: 'kg', currency: 'cny',
        taxInclusive: false, unitPrice: 88, effectiveAt: '2026-09-28T00:00:00.000Z',
        requestKey: 'price-request-0001',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('同采购单位供货关系')
    expect(mocks.priceCreate).not.toHaveBeenCalled()
  })

  it('fails closed for store roles', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/upstream/price-standards', headers: { 'x-test-role': 'MANAGER' },
    })
    expect(response.statusCode).toBe(403)
    expect(mocks.priceFindMany).not.toHaveBeenCalled()
  })
})
