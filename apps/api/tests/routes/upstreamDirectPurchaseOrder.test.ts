import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@dianjie/db'

const mocks = vi.hoisted(() => ({
  supplier: vi.fn(), warehouse: vi.fn(), sources: vi.fn(), create: vi.fn(), event: vi.fn(), log: vi.fn(), transaction: vi.fn(),
}))
vi.mock('@dianjie/db', async original => ({
  ...await original<typeof import('@dianjie/db')>(),
  prisma: {
    supplier: { findFirst: mocks.supplier }, warehouse: { findFirst: mocks.warehouse },
    upstreamPurchaseOrder: { findFirst: vi.fn() },
    $transaction: mocks.transaction,
  },
}))
vi.mock('../../src/services/upstreamDocumentNo', () => ({ nextUpstreamDocumentNo: vi.fn().mockResolvedValue('UPO-TEST-1') }))
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

const app = Fastify()
const d = (value: number | string) => new Prisma.Decimal(value)
const payload = {
  supplierId: 'supplier-a', warehouseId: 'warehouse-a', idempotencyKey: 'direct-test-123456',
  lines: [{ upstreamSourceId: 'source-a', quantity: 3, unitPrice: 12.5 }],
}

beforeAll(async () => {
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId: 'tenant-a', userId: 'user-a', role: 'SUPPLY_CHAIN' } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
  await app.ready()
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.supplier.mockResolvedValue({ id: 'supplier-a' })
  mocks.warehouse.mockResolvedValue({ id: 'warehouse-a' })
  mocks.sources.mockResolvedValue([{
    id: 'source-a', productId: 'product-a', supplierSku: null, purchaseUnit: '箱',
    inventoryUnitsPerPurchaseUnit: d(3), minOrderQty: d(2),
    product: { code: 'P001', name: '香菇', spec: '3袋/箱', status: 'ENABLED', inventoryUnit: '袋', unit: '袋' },
  }])
  mocks.create.mockImplementation(async ({ data }: any) => ({ id: 'order-a', ...data }))
  mocks.transaction.mockImplementation(async (work: any) => work({
    productUpstreamSource: { findMany: mocks.sources },
    upstreamPurchaseOrder: { create: mocks.create },
    upstreamPurchaseOrderEvent: { create: mocks.event }, opLog: { create: mocks.log },
  }))
})
describe('direct upstream purchase order', () => {
  it('uses searched supplier source and this order price without a contract', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload })
    expect(response.statusCode).toBe(201)
    const data = mocks.create.mock.calls[0][0].data
    expect(data.contractId).toBeUndefined()
    expect(data.totalAmount.toString()).toBe('37.5')
    expect(data.lines.create[0]).toMatchObject({ productId: 'product-a', purchaseUnit: '箱', inventoryUnit: '袋' })
    expect(data.lines.create[0].unitPrice.toString()).toBe('12.5')
    expect(data.lines.create[0].inventoryUnitsPerPurchaseUnit.toString()).toBe('3')
    expect(mocks.sources.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-a', supplierId: 'supplier-a', isActive: true })
  })
  it('creates and sends a purchase order to the supplier in one transaction without approval', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload: { ...payload, sendToSupplier: true } })
    expect(response.statusCode).toBe(201)
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({ status: 'SUBMITTED_TO_SUPPLIER' })
    expect(mocks.create.mock.calls[0][0].data.submittedAt).toBeInstanceOf(Date)
    expect(mocks.event.mock.calls[0][0].data).toMatchObject({ action: 'CREATE', toStatus: 'SUBMITTED_TO_SUPPLIER' })
    expect(mocks.create.mock.calls[0][0].data.approvedById).toBeUndefined()
  })
  it('rejects unavailable sources and quantities below the source minimum', async () => {
    mocks.sources.mockResolvedValueOnce([])
    expect((await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload })).statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload: { ...payload, lines: [{ ...payload.lines[0], quantity: 1 }] } })).statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects missing prices and duplicate products', async () => {
    const noPrice = { ...payload, lines: [{ upstreamSourceId: 'source-a', quantity: 3 }] }
    expect((await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload: noPrice })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/upstream/purchase-orders/direct', payload: { ...payload, lines: [payload.lines[0], payload.lines[0]] } })).statusCode).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
