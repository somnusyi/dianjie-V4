import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  receiptFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  receiptUpdate:vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: { $transaction: (...args: any[]) => mocks.transaction(...args) },
  }
})

import { Prisma } from '@dianjie/db'
import { postReceiptBusinessInTransaction, upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('upstream above-standard price exception access', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-1',
        userId: 'reviewer-2',
        role: request.headers['x-test-role'] || 'SUPPLY_CHAIN',
      }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('UPSTREAM_RECEIPT_POSTING_ENABLED', 'true')
    const receipt = {
      id: 'receipt-1', no: 'URC-1', purchaseOrderId: 'order-1', inspectorId: 'inspector-1',
      payableAmount: new Prisma.Decimal(21),
      supplier: { upstreamSensitiveCategories: [], upstreamReceiptReviewThreshold: new Prisma.Decimal(10_000) },
      purchaseOrder: { status: 'PARTIALLY_RECEIVED', lines: [] },
      shipment: { id: 'shipment-1', lines: [] },
      lines: [{
        unitPrice: new Prisma.Decimal(21), standardUnitPriceSnapshot: new Prisma.Decimal(20),
        overageQty: new Prisma.Decimal(0),
        product: { category: '常规', evidenceRequirement: 'PENDING' },
        purchaseOrderLine: { isTemporaryPrice: false }, shipmentLine: null,
      }],
    }
    mocks.receiptFindFirst.mockReset()
    mocks.receiptFindFirst
      .mockResolvedValueOnce({ purchaseOrderId: 'order-1' })
      .mockResolvedValueOnce(receipt)
    mocks.queryRaw.mockResolvedValue([{ locked: '1' }])
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      upstreamReceipt: { findFirst: (...args: any[]) => mocks.receiptFindFirst(...args) },
      $queryRaw: (...args: any[]) => mocks.queryRaw(...args),
    }))
  })

  it('拒绝缺版本和请求编号的旧过账请求且不进入事务', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/receipts/receipt-1/review-and-post',
      payload: { priceExceptionReason: '已核对临时涨价' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it.each(['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'])('超标准价即使%s也禁止入库，无例外过账',async role=>{
    const tx={upstreamReceipt:{findFirst:(...args:any[])=>mocks.receiptFindFirst(...args),update:mocks.receiptUpdate},$queryRaw:(...args:any[])=>mocks.queryRaw(...args)}
    await expect(postReceiptBusinessInTransaction(tx as any,'tenant-1',role,'reviewer-2','receipt-1',true,{priceExceptionReason:'不是准许例外的依据'} as any,true)).rejects.toMatchObject({statusCode:409,message:'实际采购价高于标准价，禁止验收入库'})
    expect(mocks.receiptUpdate).not.toHaveBeenCalled()
  })

})
