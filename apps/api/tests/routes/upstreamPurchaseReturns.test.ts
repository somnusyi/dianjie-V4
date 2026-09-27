import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  receive: vi.fn(),
  returnable: vi.fn(),
}))

vi.mock('../../src/services/upstreamPurchaseReturns', () => ({
  listUpstreamPurchaseReturns: (...args: unknown[]) => mocks.list(...args),
  getUpstreamPurchaseReturn: (...args: unknown[]) => mocks.get(...args),
  createUpstreamPurchaseReturn: (...args: unknown[]) => mocks.create(...args),
  submitUpstreamPurchaseReturn: (...args: unknown[]) => mocks.submit(...args),
  approveUpstreamPurchaseReturn: (...args: unknown[]) => mocks.approve(...args),
  rejectUpstreamPurchaseReturn: (...args: unknown[]) => mocks.reject(...args),
  cancelUpstreamPurchaseReturn: (...args: unknown[]) => mocks.cancel(...args),
  receiveUpstreamPurchaseReturn: (...args: unknown[]) => mocks.receive(...args),
  listReturnableUpstreamReceiptLines: (...args: unknown[]) => mocks.returnable(...args),
}))

import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('upstream purchase return route authorization', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: request.headers['x-test-tenant'] || 'tenant-a',
        userId: request.headers['x-test-user'] || 'user-a',
        role: request.headers['x-test-role'] || 'SUPPLY_CHAIN',
        supplierId: request.headers['x-test-supplier'] || null,
      }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([])
    mocks.get.mockResolvedValue({ id: 'return-a' })
    mocks.approve.mockResolvedValue({ replayed: false, purchaseReturn: { id: 'return-a' } })
  })

  it('blocks supplier portal roles from internal return data and actions', async () => {
    const headers = { 'x-test-role': 'SUPPLIER_OWNER', 'x-test-supplier': 'supplier-a' }
    const [list, detail, approve] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/upstream/purchase-returns', headers }),
      app.inject({ method: 'GET', url: '/api/upstream/purchase-returns/return-a', headers }),
      app.inject({ method: 'POST', url: '/api/upstream/purchase-returns/return-a/approve', headers }),
    ])
    expect(list.statusCode).toBe(403)
    expect(detail.statusCode).toBe(403)
    expect(approve.statusCode).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it.each(['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'FINANCE', 'MANAGER', 'PURCHASER'])(
    'rejects non-supply-chain role %s across every purchase-return endpoint',
    async role => {
      const headers = { 'x-test-role': role, 'x-test-supplier': 'supplier-a' }
      const requests = [
        { method: 'GET', url: '/api/upstream/purchase-returns/returnable-lines' },
        { method: 'GET', url: '/api/upstream/purchase-returns' },
        { method: 'GET', url: '/api/upstream/purchase-returns/return-a' },
        { method: 'POST', url: '/api/upstream/purchase-returns', payload: {} },
        { method: 'POST', url: '/api/upstream/purchase-returns/return-a/submit', payload: {} },
        { method: 'POST', url: '/api/upstream/purchase-returns/return-a/approve', payload: {} },
        { method: 'POST', url: '/api/upstream/purchase-returns/return-a/reject', payload: { reason: '无权限' } },
        { method: 'POST', url: '/api/upstream/purchase-returns/return-a/cancel', payload: { reason: '无权限' } },
        { method: 'POST', url: '/api/upstream/purchase-returns/return-a/receive', payload: {} },
      ] as const
      const responses = await Promise.all(requests.map(request => app.inject({ ...request, headers })))
      expect(responses.map(response => response.statusCode)).toEqual(requests.map(() => 403))
      expect(mocks.returnable).not.toHaveBeenCalled()
      expect(mocks.list).not.toHaveBeenCalled()
      expect(mocks.get).not.toHaveBeenCalled()
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.submit).not.toHaveBeenCalled()
      expect(mocks.approve).not.toHaveBeenCalled()
      expect(mocks.reject).not.toHaveBeenCalled()
      expect(mocks.cancel).not.toHaveBeenCalled()
      expect(mocks.receive).not.toHaveBeenCalled()
    },
  )

  it('uses the authenticated tenant and actor instead of request-controlled identity', async () => {
    const headers = {
      'x-test-role': 'SUPPLY_CHAIN',
      'x-test-tenant': 'tenant-b',
      'x-test-user': 'reviewer-b',
    }
    const list = await app.inject({
      method: 'GET',
      url: '/api/upstream/purchase-returns?supplierId=supplier-filter&warehouseId=warehouse-filter',
      headers,
    })
    const detail = await app.inject({
      method: 'GET', url: '/api/upstream/purchase-returns/return-a', headers,
    })
    const approve = await app.inject({
      method: 'POST', url: '/api/upstream/purchase-returns/return-a/approve', headers,
    })
    expect(list.statusCode).toBe(200)
    expect(detail.statusCode).toBe(200)
    expect(approve.statusCode).toBe(200)
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-b', supplierId: 'supplier-filter', warehouseId: 'warehouse-filter',
    }))
    expect(mocks.get).toHaveBeenCalledWith('tenant-b', 'return-a')
    expect(mocks.approve).toHaveBeenCalledWith('tenant-b', 'return-a', 'reviewer-b')
  })
})
