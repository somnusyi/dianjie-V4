import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), executeRaw: vi.fn(), supplier: vi.fn(), masters: vi.fn(),
  productNames: vi.fn(), create: vi.fn(), update: vi.fn(), audit: vi.fn(),
}))
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const tx = {
    $executeRaw: mocks.executeRaw,
    supplier: { findFirst: mocks.supplier },
    supplierProductCategory: { findMany: mocks.masters, create: mocks.create, updateMany: mocks.update },
    product: { groupBy: mocks.productNames },
    opLog: { create: mocks.audit },
  }
  mocks.transaction.mockImplementation(async (callback: any) => callback(tx))
  return { ...actual, prisma: { ...tx, $transaction: mocks.transaction } }
})
vi.mock('../../src/lib/cache', () => ({ cached: (_key: string, _ttl: number, fn: () => unknown) => fn(), invalidatePattern: vi.fn() }))
vi.mock('../../src/routes/upload', () => ({ signOssKey: vi.fn(() => null) }))
vi.mock('../../src/services/notify', () => ({ fireAndForget: vi.fn() }))
vi.mock('../../src/services/notify/productChange', () => ({ fireAndForgetNotifyProductChange: vi.fn() }))
vi.mock('../../src/services/documentNo', () => ({ nextDocumentNo: vi.fn() }))
vi.mock('../../src/services/supplierStockBatch', () => ({ createSupplierStockBatchIncrease: vi.fn() }))
vi.mock('../../src/services/supplierStockReservation', () => ({ getSupplierReservedStock: vi.fn(), stockAvailability: vi.fn() }))
import { productRoutes } from '../../src/routes/products'
const app = Fastify()
const payload = { categories: [{ id: null, name: '历史乙' }, { id: 'c1', name: '蔬菜' }, { id: null, name: '历史甲' }] }
const url = '/api/products/categories-order?supplierId=s1'
beforeAll(async () => {
  app.decorate('authenticate', async (request: any) => { request.user = {
    tenantId: 't1', userId: 'u1', role: request.headers['x-test-role'] || 'SUPPLY_CHAIN',
  } })
  await app.register(productRoutes, { prefix: '/api/products' }); await app.ready()
})
afterAll(async () => app.close())
beforeEach(() => {
  vi.clearAllMocks()
  mocks.executeRaw.mockResolvedValue(1)
  mocks.supplier.mockResolvedValue({ id: 's1' })
  mocks.masters.mockResolvedValue([{ id: 'c1', name: '蔬菜', sortOrder: 0, isActive: true, isSystem: false }])
  mocks.productNames.mockResolvedValue([
    { category: '蔬菜', _count: { _all: 1 } }, { category: '历史甲', _count: { _all: 1 } }, { category: '历史乙', _count: { _all: 1 } },
  ])
  mocks.create.mockImplementation(async ({ data }: any) => ({ ...data, id: `new-${data.name}` }))
  mocks.update.mockResolvedValue({ count: 1 }); mocks.audit.mockResolvedValue({ id: 'log' })
})
describe('DJ060 explicit category-order save route (mocked persistence)', () => {
  it('GET exposes legacy names but performs no materialization', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/products/categories?supplierId=s1' })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: null, name: '历史甲' }), expect.objectContaining({ id: null, name: '历史乙' })]))
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('valid full snapshot materializes both historical names under scoped serializable transaction and audit', async () => {
    const result = await app.inject({ method: 'PATCH', url, payload })
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ ok: true, count: 3 })
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' })
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1)
    expect(mocks.supplier).toHaveBeenCalledWith({ where: { id: 's1', tenantId: 't1' }, select: { id: true } })
    expect(mocks.productNames).toHaveBeenCalledWith(expect.objectContaining({ where: { supplierId: 's1', tenantId: 't1' } }))
    expect(mocks.create.mock.calls.map(([arg]) => arg.data)).toEqual([
      { tenantId: 't1', supplierId: 's1', name: '历史乙', sortOrder: 0, isActive: true, isSystem: false },
      { tenantId: 't1', supplierId: 's1', name: '历史甲', sortOrder: 2, isActive: true, isSystem: false },
    ])
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'c1', tenantId: 't1', supplierId: 's1', name: '蔬菜' }, data: { sortOrder: 1 } })
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      tenantId: 't1', userId: 'u1', role: 'SUPPLY_CHAIN', targetId: 's1', metadata: expect.objectContaining({
        categoryIds: ['new-历史乙', 'c1', 'new-历史甲'], materializedNames: ['历史乙', '历史甲'],
      }),
    }) }))
  })
  it.each([
    [{ id: 'c1', name: '蔬菜' }, { id: null, name: '历史甲' }],
    [{ id: 'foreign', name: '蔬菜' }, { id: null, name: '历史甲' }, { id: null, name: '历史乙' }],
    [{ id: 'c1', name: '蔬菜' }, { id: null, name: '伪造分类' }, { id: null, name: '历史乙' }],
  ])('omitted, foreign, or invented references return 409 before any write (%j)', async (...categories) => {
    const result = await app.inject({ method: 'PATCH', url, payload: { categories } })
    expect(result.statusCode).toBe(409)
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('duplicate references reject before updates', async () => {
    const result = await app.inject({ method: 'PATCH', url, payload: { categories: [payload.categories[0], payload.categories[0], payload.categories[1]] } })
    expect(result.statusCode).toBe(400); expect(mocks.create).not.toHaveBeenCalled()
  })
  it('audit failure rejects callback and response; mock does not claim real SQL rollback', async () => {
    const failure = Error('audit unavailable')
    mocks.audit.mockRejectedValueOnce(failure)
    const result = await app.inject({ method: 'PATCH', url, payload })
    expect(result.statusCode).toBe(500)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.audit).toHaveBeenCalledTimes(1)
    expect(result.json().message).toBe('audit unavailable')
    expect(mocks.create).toHaveBeenCalledTimes(2)
    // Actual rollback must be verified with the real isolated PostgreSQL transaction.
  })
  it.each(['P2002', 'P2034'])('transaction conflict %s is reported as 409', async code => {
    mocks.create.mockRejectedValueOnce(Object.assign(Error('conflict'), { code }))
    const result = await app.inject({ method: 'PATCH', url, payload })
    expect(result.statusCode).toBe(409); expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('tenant supplier missing or forbidden role cannot materialize categories', async () => {
    mocks.supplier.mockResolvedValueOnce(null)
    const missing = await app.inject({ method: 'PATCH', url, payload })
    expect(missing.statusCode).toBe(404); expect(mocks.create).not.toHaveBeenCalled()
    const forbidden = await app.inject({ method: 'PATCH', url, headers: { 'x-test-role': 'FINANCE' }, payload })
    expect(forbidden.statusCode).toBe(403); expect(mocks.create).not.toHaveBeenCalled()
  })
  it('legacy ID-only request is compatible only with a complete master-only set', async () => {
    mocks.productNames.mockResolvedValueOnce([{ category: '蔬菜', _count: { _all: 1 } }])
    const result = await app.inject({ method: 'PATCH', url, payload: { ids: ['c1'] } })
    expect(result.statusCode).toBe(200); expect(mocks.create).not.toHaveBeenCalled()
    const incomplete = await app.inject({ method: 'PATCH', url, payload: { ids: ['c1'] } })
    expect(incomplete.statusCode).toBe(409)
  })
})
