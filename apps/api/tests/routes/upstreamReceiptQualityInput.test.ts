import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  outerReceiptFindFirst: vi.fn(),
  txReceiptFindFirst: vi.fn(),
  shipmentFindFirst: vi.fn(),
  receiptLineFindMany: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      upstreamReceipt: { findFirst: (...args: any[]) => mocks.outerReceiptFindFirst(...args) },
      $transaction: (...args: any[]) => mocks.transaction(...args),
    },
  }
})

import { Prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('upstream receipt quality input contract', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.outerReceiptFindFirst.mockResolvedValue(null)
    mocks.txReceiptFindFirst.mockResolvedValue(null)
    mocks.queryRaw.mockResolvedValue([{ locked: '1' }])
    mocks.receiptLineFindMany.mockResolvedValue([])
    mocks.shipmentFindFirst
      .mockResolvedValueOnce({ purchaseOrderId: 'order-1' })
      .mockResolvedValueOnce({
        id: 'shipment-1', purchaseOrderId: 'order-1', supplierId: 'supplier-1', warehouseId: 'warehouse-1',
        supplier: { id: 'supplier-1' },
        lines: [{
          id: 'shipment-line-1', purchaseOrderLineId: 'order-line-1',
          shippedQty: new Prisma.Decimal(10), manufactureDate: null, expiryDate: null, batchNo: null,
        }],
        purchaseOrder: {
          lines: [{
            id: 'order-line-1', productId: 'product-1', productNameSnapshot: '羊肚菌',
            qualityStandardId: null,
          }],
        },
      })
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      $queryRaw: (...args: any[]) => mocks.queryRaw(...args),
      upstreamReceipt: { findFirst: (...args: any[]) => mocks.txReceiptFindFirst(...args) },
      upstreamShipment: { findFirst: (...args: any[]) => mocks.shipmentFindFirst(...args) },
      upstreamReceiptLine: { findMany: (...args: any[]) => mocks.receiptLineFindMany(...args) },
    }))
  })

  it('returns 400 instead of leaking a database constraint error when an unstandardized line submits a quality result', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/shipments/shipment-1/receipts',
      payload: {
        idempotencyKey: 'receipt-quality-request-1',
        finalForShipment: true,
        lines: [{
          shipmentLineId: 'shipment-line-1',
          arrivedQty: 10,
          acceptedQty: 10,
          damagedQty: 0,
          rejectedQty: 0,
          qualityResult: 'PASS',
        }],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('未配置质量标准')
  })
})
