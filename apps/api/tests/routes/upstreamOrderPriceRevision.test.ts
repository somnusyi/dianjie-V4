import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), findOrder: vi.fn(), updateOrder: vi.fn(), createRevision: vi.fn(), findRevision: vi.fn(), updateRevision: vi.fn(), updateLine: vi.fn(), event: vi.fn(), lock: vi.fn() }))
vi.mock('@dianjie/db', async original => ({ ...await original<typeof import('@dianjie/db')>(), prisma: { $transaction: mocks.transaction } }))
import { Prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'
const app = Fastify()
const d = (value: number | string) => new Prisma.Decimal(value)
let order: any, revision: any
beforeAll(async () => {
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: req.headers['x-tenant'] || 'tenant-a', userId: 'actor', role: req.headers['x-role'] || 'SUPPLIER_OWNER', supplierId: req.headers['x-supplier'] || 'supplier-a' } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  vi.clearAllMocks()
  order = { id: 'order-a', tenantId: 'tenant-a', supplierId: 'supplier-a', status: 'SUBMITTED_TO_SUPPLIER', rowVersion: 2, currentRevisionNo: 0, hasTemporaryPrice: false, taxInclusive: true, expectedArrivalAt: null,
    lines: [{ id: 'line-a', orderedQty: d(3), unitPrice: d(10), shippedQty: d(0), receivedQty: d(0), taxRate: d(0) }] }
  revision = null
  mocks.findOrder.mockImplementation(async ({ where }: any) => {
    if (where.tenantId !== order.tenantId || (where.supplierId && where.supplierId !== order.supplierId) || (typeof where.status === 'string' && where.status !== order.status) || (where.status?.in && !where.status.in.includes(order.status)) || (where.currentRevisionNo !== undefined && where.currentRevisionNo !== order.currentRevisionNo)) return null
    return order
  })
  mocks.createRevision.mockImplementation(async ({ data }: any) => { revision = { id: 'revision-a', status: 'PENDING', ...data }; return revision })
  mocks.findRevision.mockImplementation(async ({ where }: any) => revision && revision.tenantId === where.tenantId && revision.status === where.status ? revision : null)
  mocks.updateRevision.mockImplementation(async ({ data }: any) => Object.assign(revision, data))
  mocks.updateOrder.mockImplementation(async ({ data }: any) => {
    for (const [key, value] of Object.entries(data)) order[key] = (value as any)?.increment ? order[key] + (value as any).increment : value
    return order
  })
  mocks.transaction.mockImplementation(async (work: any) => work({ $queryRaw: mocks.lock, upstreamPurchaseOrder: { findFirst: mocks.findOrder, update: mocks.updateOrder }, upstreamPurchaseOrderRevision: { create: mocks.createRevision, findFirst: mocks.findRevision, update: mocks.updateRevision }, upstreamPurchaseOrderLine: { update: mocks.updateLine }, upstreamPurchaseOrderEvent: { create: mocks.event } }))
})
const propose = (payload: any = { rowVersion: 2, reason: '本单涨价申请', lines: [{ lineId: 'line-a', quantity: 3, unitPrice: 10.123456 }] }, headers: any = {}) => app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/order-a/propose-change', payload, headers })
const review = (payload: any = { rowVersion: 3, decision: 'ACCEPT' }, headers: any = { 'x-role': 'SUPPLY_CHAIN' }) => app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/order-a/revisions/revision-a/review', payload, headers })
describe('supplier order price request and internal review', () => {
  it('proposal keeps old order prices; internal approval alone updates six-place price and four-place amount once', async () => {
    expect((await propose()).statusCode).toBe(201)
    expect(mocks.findOrder.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-a', supplierId: 'supplier-a', id: 'order-a' })
    expect(mocks.lock).toHaveBeenCalledOnce()
    expect(order.lines[0].unitPrice.eq(10)).toBe(true)
    expect(mocks.updateLine).not.toHaveBeenCalled()
    expect(revision.beforeSnapshot.lines[0].unitPrice).toBe('10')
    expect(revision.afterSnapshot.lines[0].unitPrice).toBe('10.123456')
    expect((await propose()).statusCode).toBe(409)
    expect(mocks.createRevision).toHaveBeenCalledOnce()
    expect((await review()).statusCode).toBe(200)
    const line = mocks.updateLine.mock.calls[0][0].data
    expect(line.unitPrice.toString()).toBe('10.123456')
    expect(line.totalAmount.toString()).toBe('30.3704')
    expect(revision.status).toBe('ACCEPTED')
    expect((await review()).statusCode).toBe(409)
    expect(mocks.updateLine).toHaveBeenCalledOnce()
  })
  it('reject keeps order price unchanged and retains rejection reason and both price snapshots', async () => {
    await propose()
    expect((await review({ rowVersion: 3, decision: 'REJECT', note: '本批仍按原价' })).statusCode).toBe(200)
    expect(mocks.updateLine).not.toHaveBeenCalled()
    expect(revision).toMatchObject({ status: 'REJECTED', reviewNote: '本批仍按原价' })
    expect(revision.afterSnapshot.lines[0].unitPrice).toBe('10.123456')
  })
  it('isolates tenant, supplier and role', async () => {
    expect((await propose(undefined, { 'x-tenant': 'tenant-b' })).statusCode).toBe(409)
    expect((await propose(undefined, { 'x-supplier': 'supplier-b' })).statusCode).toBe(409)
    expect((await review(undefined, { 'x-role': 'SUPPLIER' })).statusCode).toBe(403)
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('rejects duplicate/foreign lines, missing/stale versions and changed shipment facts before any proposal write', async () => {
    for (const lines of [[{ lineId: 'other', quantity: 3 }], [{ lineId: 'line-a', quantity: 3 }, { lineId: 'line-a', quantity: 4 }]]) expect((await propose({ rowVersion: 2, reason: '数量', lines })).statusCode).toBe(400)
    expect((await propose({ reason: '价格', lines: [{ lineId: 'line-a', quantity: 3, unitPrice: 12 }] })).statusCode).toBe(400)
    expect((await propose({ rowVersion: 1, reason: '价格', lines: [{ lineId: 'line-a', quantity: 3, unitPrice: 12 }] })).statusCode).toBe(409)
    order.lines[0].shippedQty = d(1)
    expect((await propose()).statusCode).toBe(409)
    expect(mocks.createRevision).not.toHaveBeenCalled()
  })
  it('rejects stale review and post-proposal shipped facts without line mutation', async () => {
    await propose()
    expect((await review({ rowVersion: 2, decision: 'ACCEPT' })).statusCode).toBe(409)
    order.lines[0].shippedQty = d(1)
    expect((await review()).statusCode).toBe(409)
    expect(mocks.updateLine).not.toHaveBeenCalled()
  })
  it('accepts historic quantity-only snapshots without changing their price', async () => {
    order.status = 'CHANGE_PROPOSED'; order.currentRevisionNo = 1
    revision = { id: 'revision-a', tenantId: 'tenant-a', revisionNo: 1, status: 'PENDING', beforeSnapshot: { lines: [{ id: 'line-a', quantity: '3' }] }, afterSnapshot: { lines: [{ id: 'line-a', quantity: '4' }] } }
    expect((await review({ decision: 'ACCEPT' })).statusCode).toBe(200)
    expect(mocks.updateLine.mock.calls[0][0].data.unitPrice.eq(10)).toBe(true)
    expect(mocks.updateLine.mock.calls[0][0].data.orderedQty.eq(4)).toBe(true)
  })
})
