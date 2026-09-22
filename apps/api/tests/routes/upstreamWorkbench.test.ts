import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  orderCount: vi.fn(),
  shipmentCount: vi.fn(),
  receiptCount: vi.fn(),
  receiptFindFirst: vi.fn(),
  claimCount: vi.fn(),
  claimFindFirst: vi.fn(),
  claimLineFindMany: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  statementCount: vi.fn(),
}))

vi.mock('@dianjie/db', async () => {
  const actual = await vi.importActual<any>('@dianjie/db')
  return {
    ...actual,
    prisma: {
    upstreamPurchaseOrder: { count: (...args: any[]) => mocks.orderCount(...args) },
    upstreamShipment: { count: (...args: any[]) => mocks.shipmentCount(...args) },
    upstreamReceipt: {
      count: (...args: any[]) => mocks.receiptCount(...args),
      findFirst: (...args: any[]) => mocks.receiptFindFirst(...args),
    },
    upstreamArrivalClaim: {
      count: (...args: any[]) => mocks.claimCount(...args),
      findFirst: (...args: any[]) => mocks.claimFindFirst(...args),
    },
    $transaction: (...args: any[]) => mocks.transaction(...args),
    upstreamSettlementStatement: { count: (...args: any[]) => mocks.statementCount(...args) },
    },
  }
})

import {
  normalizePostReceiptClaimLines,
  postReceiptClaimRequestFingerprint,
  upstreamProcurementRoutes,
} from '../../src/routes/upstreamProcurement'

describe('upstream role workbench', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: request.headers['x-test-tenant'] || 'tenant-workbench',
        userId: 'user-workbench',
        role: request.headers['x-test-role'] || 'SUPPLY_CHAIN',
        supplierId: request.headers['x-test-supplier'] || null,
      }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.orderCount.mockResolvedValue(2)
    mocks.shipmentCount.mockResolvedValue(3)
    mocks.receiptCount.mockResolvedValue(4)
    mocks.receiptFindFirst.mockResolvedValue(null)
    mocks.claimFindFirst.mockResolvedValue(null)
    mocks.claimCount.mockResolvedValue(5)
    mocks.statementCount.mockResolvedValue(6)
    mocks.queryRaw.mockResolvedValue([{ locked: '1' }])
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      $queryRaw: (...args: any[]) => mocks.queryRaw(...args),
      upstreamReceipt: { findFirst: (...args: any[]) => mocks.receiptFindFirst(...args) },
      upstreamArrivalClaim: { findFirst: (...args: any[]) => mocks.claimFindFirst(...args) },
      upstreamArrivalClaimLine: { findMany: (...args: any[]) => mocks.claimLineFindMany(...args) },
    }))
  })

  it('summarizes only actionable internal purchasing states', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/upstream/workbench' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      audience: 'INTERNAL',
      total: 20,
      counts: { orders: 2, shipments: 3, receipts: 4, claims: 5, statements: 6 },
    })
    expect(mocks.orderCount).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-workbench', status: { in: ['PENDING_APPROVAL', 'CHANGE_PROPOSED'] } },
    })
  })

  it('keeps tenant ADMIN aligned with the supply-chain workspace contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/upstream/workbench',
      headers: { 'x-test-role': 'ADMIN' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ audience: 'INTERNAL' })
  })

  it('isolates supplier pending work to the authenticated supplier binding', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/upstream/workbench',
      headers: { 'x-test-role': 'SUPPLIER_OWNER', 'x-test-supplier': 'supplier-a' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      audience: 'SUPPLIER',
      total: 16,
      counts: { orders: 2, shipments: 3, receipts: 0, claims: 5, statements: 6 },
    })
    expect(mocks.orderCount).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-workbench',
        supplierId: 'supplier-a',
        status: { in: ['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'PARTIALLY_RECEIVED'] },
      },
    })
  })

  it('shows finance only statements ready to lock', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/upstream/workbench',
      headers: { 'x-test-role': 'FINANCE' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      audience: 'FINANCE',
      total: 6,
      counts: { orders: 0, shipments: 0, receipts: 0, claims: 0, statements: 6 },
    })
    expect(mocks.statementCount).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-workbench', status: 'CONFIRMED' },
    })
  })

  it('fails closed for store roles', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/upstream/workbench',
      headers: { 'x-test-role': 'MANAGER' },
    })

    expect(response.statusCode).toBe(403)
  })

  it('lets a supplier open its own receipt detail from an arrival claim', async () => {
    mocks.receiptFindFirst.mockImplementation(async ({ where }: any) => (
      where.tenantId === 'tenant-workbench' && where.supplierId === 'supplier-a'
    )
      ? {
          id: 'receipt-1', no: 'URC202609000001', supplierId: 'supplier-a', status: 'POSTED', payableAmount: 120,
          supplier: { id: 'supplier-a', no: 'SUP-A', name: '供应商 A', postReceiptClaimHours: 48 },
          purchaseOrder: { id: 'order-1', no: 'UPO202609000001', status: 'RECEIVED', totalAmount: 200, amountWithoutTax: 180 },
          shipment: { id: 'shipment-1', no: 'USH202609000001', status: 'RECEIVED' },
          lines: [],
        }
      : null)

    const own = await app.inject({
      method: 'GET', url: '/api/upstream/receipts/receipt-1',
      headers: { 'x-test-role': 'SUPPLIER_OWNER', 'x-test-supplier': 'supplier-a' },
    })

    expect(own.statusCode).toBe(200)
    expect(own.json()).toMatchObject({ id: 'receipt-1', supplierId: 'supplier-a' })
    expect(mocks.receiptFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'receipt-1', tenantId: 'tenant-workbench', supplierId: 'supplier-a' },
    }))
  })

  it('keeps another supplier and another tenant from seeing the receipt', async () => {
    mocks.receiptFindFirst.mockImplementation(async ({ where }: any) => (
      where.tenantId === 'tenant-workbench' && where.supplierId === 'supplier-a'
    )
      ? { id: 'receipt-1', supplierId: 'supplier-a', lines: [] }
      : null)

    const otherSupplier = await app.inject({
      method: 'GET', url: '/api/upstream/receipts/receipt-1',
      headers: { 'x-test-role': 'SUPPLIER_OWNER', 'x-test-supplier': 'supplier-b' },
    })
    const otherTenant = await app.inject({
      method: 'GET', url: '/api/upstream/receipts/receipt-1',
      headers: {
        'x-test-role': 'SUPPLIER_OWNER',
        'x-test-supplier': 'supplier-a',
        'x-test-tenant': 'tenant-other',
      },
    })

    expect(otherSupplier.statusCode).toBe(404)
    expect(otherTenant.statusCode).toBe(404)
    expect(mocks.receiptFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'receipt-1', tenantId: 'tenant-workbench', supplierId: 'supplier-b' },
    }))
    expect(mocks.receiptFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'receipt-1', tenantId: 'tenant-other', supplierId: 'supplier-a' },
    }))
  })

  it('rejects an unbound supplier account and a non-supplier role', async () => {
    const unboundSupplier = await app.inject({
      method: 'GET', url: '/api/upstream/receipts/receipt-1',
      headers: { 'x-test-role': 'SUPPLIER_OWNER' },
    })
    const storeRole = await app.inject({
      method: 'GET', url: '/api/upstream/receipts/receipt-1',
      headers: { 'x-test-role': 'MANAGER' },
    })

    expect(unboundSupplier.statusCode).toBe(403)
    expect(storeRole.statusCode).toBe(403)
    expect(mocks.receiptFindFirst).not.toHaveBeenCalled()
  })

  function postReceiptClaimFixture() {
    const purchaseOrderLine = {
      id: 'po-line-1',
      productId: 'product-1',
      productNameSnapshot: '测试土豆',
      purchaseUnit: '箱',
      orderedQty: 10,
      confirmedQty: 10,
      receivedQty: 8,
      unitPrice: 12,
    }
    return {
      id: 'receipt-1',
      purchaseOrderId: 'po-1',
      supplierId: 'supplier-a',
      postedAt: new Date(),
      supplier: { postReceiptClaimHours: 48 },
      purchaseOrder: { lines: [purchaseOrderLine] },
      lines: [{
        id: 'receipt-line-1',
        purchaseOrderLineId: purchaseOrderLine.id,
        acceptedQty: 8,
        purchaseOrderLine,
      }],
    }
  }

  const postReceiptClaimPayload = {
    idempotencyKey: 'claim-idempotency-1',
    type: 'POST_RECEIPT_DAMAGE' as const,
    description: '拆包后发现破损',
    evidence: [{ url: 'evidence/damage-1.jpg' }],
    lines: [{ receiptLineId: 'receipt-line-1', affectedQty: 1 }],
  }

  it('按采购单行归一化后拒绝同一商品重复补报', async () => {
    mocks.receiptFindFirst.mockResolvedValue(postReceiptClaimFixture())

    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/receipts/receipt-1/post-receipt-claims',
      payload: {
        ...postReceiptClaimPayload,
        type: 'SHORTAGE',
        lines: [
          { purchaseOrderLineId: 'po-line-1', affectedQty: 1 },
          { receiptLineId: 'receipt-line-1', affectedQty: 1 },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: '同一商品不能重复补报' })
    expect(mocks.claimFindFirst).not.toHaveBeenCalled()
  })

  it('完全相同的补报请求才按幂等键重放', async () => {
    const receipt = postReceiptClaimFixture()
    const normalizedLines = normalizePostReceiptClaimLines(postReceiptClaimPayload, receipt)
    const requestFingerprint = postReceiptClaimRequestFingerprint({
      receiptId: receipt.id,
      claim: postReceiptClaimPayload,
      normalizedLines,
    })
    mocks.receiptFindFirst.mockResolvedValue(receipt)
    mocks.claimFindFirst.mockResolvedValue({
      id: 'claim-1',
      receiptId: receipt.id,
      type: postReceiptClaimPayload.type,
      requestFingerprint,
      lines: [],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/receipts/receipt-1/post-receipt-claims',
      payload: postReceiptClaimPayload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'claim-1', receiptId: 'receipt-1' })
  })

  it.each([
    ['另一张收货单', { receiptId: 'receipt-other', type: 'POST_RECEIPT_DAMAGE', requestFingerprint: 'same' }],
    ['另一种差异类型', { receiptId: 'receipt-1', type: 'SHORTAGE', requestFingerprint: 'same' }],
    ['另一份补报内容', { receiptId: 'receipt-1', type: 'POST_RECEIPT_DAMAGE', requestFingerprint: 'different' }],
  ])('拒绝把已用幂等键重用于%s', async (_label, conflict) => {
    mocks.receiptFindFirst.mockResolvedValue(postReceiptClaimFixture())
    mocks.claimFindFirst.mockResolvedValue({ id: 'claim-existing', ...conflict, lines: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/api/upstream/receipts/receipt-1/post-receipt-claims',
      payload: postReceiptClaimPayload,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: '同一幂等键不能用于不同的补报请求' })
  })
})
