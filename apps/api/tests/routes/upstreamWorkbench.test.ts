import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  orderCount: vi.fn(),
  shipmentCount: vi.fn(),
  receiptCount: vi.fn(),
  claimCount: vi.fn(),
  statementCount: vi.fn(),
}))

vi.mock('@dianjie/db', async () => {
  const actual = await vi.importActual<any>('@dianjie/db')
  return {
    ...actual,
    prisma: {
    upstreamPurchaseOrder: { count: (...args: any[]) => mocks.orderCount(...args) },
    upstreamShipment: { count: (...args: any[]) => mocks.shipmentCount(...args) },
    upstreamReceipt: { count: (...args: any[]) => mocks.receiptCount(...args) },
    upstreamArrivalClaim: { count: (...args: any[]) => mocks.claimCount(...args) },
    upstreamSettlementStatement: { count: (...args: any[]) => mocks.statementCount(...args) },
    },
  }
})

import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('upstream role workbench', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-workbench',
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
    mocks.claimCount.mockResolvedValue(5)
    mocks.statementCount.mockResolvedValue(6)
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
})
