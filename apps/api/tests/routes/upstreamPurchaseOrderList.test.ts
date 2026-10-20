import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn(), transaction: vi.fn() }))
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: {
    upstreamPurchaseOrder: { findMany: mocks.findMany, count: mocks.count },
    $transaction: mocks.transaction,
  } }
})
import {supplierVisiblePurchaseOrder} from '../../src/lib/upstream-order-visibility'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('purchase order server filters and optional pagination', () => {
  let app: ReturnType<typeof Fastify>
  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (req: any) => {
      req.user = { tenantId: req.headers['x-test-tenant'] || 'tenant-a', userId: 'user-a',
        role: req.headers['x-test-role'] || 'SUPPLY_CHAIN', supplierId: req.headers['x-test-supplier'] || null }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findMany.mockResolvedValue([{ id: 'order-201' }])
    mocks.count.mockResolvedValue(221)
    mocks.transaction.mockImplementation(async (callback: any) => callback({
      upstreamPurchaseOrder: { findMany: mocks.findMany, count: mocks.count },
    }))
  })
  it('preserves the legacy array contract', async () => {
    const response = await app.inject('/api/upstream/purchase-orders')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([{ id: 'order-201' }])
    expect(mocks.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-a' }, take: 200 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('filters before pagination and can reach records past 200', async () => {
    const response = await app.inject('/api/upstream/purchase-orders?paginated=true&page=11&pageSize=20&supplierId=supplier-a&productQuery=ZZ9&dateFrom=2026-10-01&dateTo=2026-10-18')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [{ id: 'order-201' }], total: 221, page: 11, pageSize: 20 })
    const args = mocks.findMany.mock.calls[0][0]
    expect(args.skip).toBe(200)
    expect(args.take).toBe(20)
    expect(args.where).toEqual({ tenantId: 'tenant-a', supplierId: 'supplier-a',
      createdAt: { gte: new Date('2026-09-30T16:00:00Z'), lt: new Date('2026-10-18T16:00:00Z') },
      lines: { some: { tenantId: 'tenant-a', OR: [
        { productNameSnapshot: { contains: 'ZZ9', mode: 'insensitive' } },
        { productCodeSnapshot: { contains: 'ZZ9', mode: 'insensitive' } },
      ] } },
    })
    expect(mocks.count).toHaveBeenCalledWith({ where: args.where })
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(mocks.transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' })
  })
  it('supports arrival date and one-sided bounds', async () => {
    await app.inject('/api/upstream/purchase-orders?paginated=true&dateField=expectedArrivalAt&dateTo=2026-10-18')
    expect(mocks.findMany.mock.calls[0][0].where.expectedArrivalAt).toEqual({ lt: new Date('2026-10-18T16:00:00Z') })
    vi.clearAllMocks()
    mocks.findMany.mockResolvedValue([])
    await app.inject('/api/upstream/purchase-orders?dateFrom=2026-10-01')
    expect(mocks.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date('2026-09-30T16:00:00Z') })
  })
  it('never trusts an external supplier override', async () => {
    const response = await app.inject({ url: '/api/upstream/purchase-orders?paginated=true&supplierId=supplier-b',
      headers: { 'x-test-role': 'SUPPLIER_OWNER', 'x-test-supplier': 'supplier-a', 'x-test-tenant': 'tenant-bound' } })
    expect(response.statusCode).toBe(200)
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-bound', supplierId: 'supplier-a', AND:[supplierVisiblePurchaseOrder] })
  })
  it.each(['FINANCE', 'STORE_MANAGER', 'SUPPLIER_OWNER'])('rejects an unauthorized or unbound role %s', async role => {
    const response = await app.inject({ url: '/api/upstream/purchase-orders?paginated=true', headers: { 'x-test-role': role } })
    expect(response.statusCode).toBe(403)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
  it.each([
    'dateFrom=2026-02-30', 'dateFrom=invalid', 'dateFrom=2026-10-18&dateTo=2026-10-17',
    'dateField=updatedAt', 'page=0', 'page=-1', 'page=1.5', 'page=100001', 'pageSize=101',
    'pageSize=0', 'paginated=yes', 'status=INVALID', 'supplierId=a&supplierId=b',
  ])('rejects malformed query %s', async query => {
    const response = await app.inject(`/api/upstream/purchase-orders?paginated=true&${query}`)
    expect(response.statusCode).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
