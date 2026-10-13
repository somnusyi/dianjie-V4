import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ shipment: vi.fn(), receipt: vi.fn(), tenant: vi.fn() }))
vi.mock('@dianjie/db', async importOriginal => ({
  ...await importOriginal<typeof import('@dianjie/db')>(),
  prisma: {
    upstreamShipment: { findFirst: mocks.shipment },
    upstreamReceipt: { findFirst: mocks.receipt },
    tenant: { findUnique: mocks.tenant },
  },
}))
import { Prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

const app = Fastify()
const d = (value: number) => new Prisma.Decimal(value)
beforeAll(async () => {
  app.decorate('authenticate', async (req: any) => {
    req.user = { tenantId: 'tenant-context', userId: 'author-context', role: req.headers['x-test-role'] || 'SUPPLY_CHAIN' }
  })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  vi.clearAllMocks()
  mocks.receipt.mockResolvedValue(null)
  mocks.tenant.mockResolvedValue({ name: '测试采购机构' })
  mocks.shipment.mockResolvedValue({ id: 'shipment-context', status: 'SHIPPED', no: 'SH-TEST',
    lines: [{ id: 'line-context', shippedQty: d(10), receiptLines: [{ arrivedQty: d(3) }],
      purchaseOrderLine: { unitPrice: d(2), purchaseUnit: '箱', inventoryUnit: '件', inventoryUnitsPerPurchaseUnit: d(6) },
    }],
  })
})
const get = (headers = {}) => app.inject({ method: 'GET', url: '/api/upstream/shipments/shipment-context/receipt-context', headers })

it('returns only the remaining quantity with frozen units and the actual organization', async () => {
  const result = await get()
  expect(result.statusCode).toBe(200)
  expect(result.json()).toMatchObject({ organizationName: '测试采购机构', lines: [{ arrivedQty: '7', acceptedQty: '7', payableAmount: '14', purchaseUnit: '箱', inventoryUnitsPerPurchaseUnit: '6' }] })
  expect(mocks.shipment.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-context', id: 'shipment-context' })
})
it('restores the author’s unfinished original, including an audited draft, before offering new creation', async () => {
  mocks.receipt.mockResolvedValue({ id: 'existing-audited', no: 'RC-OLD' })
  expect((await get()).json()).toEqual({ existingSourceId: 'existing-audited', existingNo: 'RC-OLD' })
  const where = mocks.receipt.mock.calls[0][0].where
  expect(where.createdById).toBe('author-context')
  expect(where.tenantId).toBe('tenant-context')
  expect(where.OR[1].approvalStatus.in).toContain('AUDITED')
})
it('rejects a new form after all quantity was recorded by another person', async () => {
  const shipment = await mocks.shipment()
  shipment.lines[0].receiptLines = [{ arrivedQty: d(10) }]
  mocks.shipment.mockResolvedValue(shipment)
  const result = await get()
  expect(result.statusCode).toBe(409)
  expect(result.json().error).toContain('查看已有收货单')
})
it('rejects an outside role before fetching source data', async () => {
  expect((await get({ 'x-test-role': 'STORE_MANAGER' })).statusCode).toBe(403)
  expect(mocks.shipment).not.toHaveBeenCalled()
})
it('does not reveal a shipment outside the tenant', async () => {
  mocks.shipment.mockResolvedValue(null)
  expect((await get()).statusCode).toBe(404)
  expect(mocks.receipt).not.toHaveBeenCalled()
})
