import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(),
  supplierFindFirst: vi.fn(),
  sourceFindMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      upstreamSupplierContract: { findUnique: mocks.contractFindUnique },
      supplier: { findFirst: mocks.supplierFindFirst },
      productUpstreamSource: { findMany: mocks.sourceFindMany },
      $transaction: mocks.transaction,
    },
  }
})

import { upstreamContractRequestFingerprint, upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

const rawPayload = {
  supplierId: 'supplier-1',
  contractNo: 'HT202609-01',
  title: '2026年菌菇供货合同',
  startsAt: '2026-09-01T00:00:00.000Z',
  settlementCycle: 'MONTHLY',
  settlementDays: 0,
  taxInclusive: true,
  currency: 'CNY',
  idempotencyKey: 'contract-request-1',
  lines: [{
    upstreamSourceId: 'source-1',
    unitPrice: 88,
    packageMultiple: 1,
    shortTolerancePct: 0,
    overTolerancePct: 0,
  }],
}

const parsedPayload = {
  ...rawPayload,
  startsAt: new Date(rawPayload.startsAt),
  settlementCycle: 'MONTHLY' as const,
  lines: rawPayload.lines,
}

const stored = {
  id: 'contract-1',
  tenantId: 'tenant-1',
  supplierId: 'supplier-1',
  contractNo: rawPayload.contractNo,
  title: rawPayload.title,
  requestFingerprint: upstreamContractRequestFingerprint(parsedPayload),
  lines: [{ id: 'line-1' }],
}

describe('upstream contract route idempotency', () => {
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
    mocks.supplierFindFirst.mockResolvedValue({ id: 'supplier-1' })
    mocks.sourceFindMany.mockResolvedValue([])
  })

  it('持久重放返回同一合同且不再写入', async () => {
    mocks.contractFindUnique.mockResolvedValue(stored)
    const response = await app.inject({ method: 'POST', url: '/api/upstream/contracts', payload: rawPayload })
    expect(response.statusCode).toBe(200)
    expect(response.headers['idempotent-replay']).toBe('true')
    expect(response.json().id).toBe('contract-1')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('同键不同内容返回 409', async () => {
    mocks.contractFindUnique.mockResolvedValue({ ...stored, requestFingerprint: 'different' })
    const response = await app.inject({ method: 'POST', url: '/api/upstream/contracts', payload: rawPayload })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('同一幂等键')
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it.each(['P2002', 'P2034'])('并发冲突 %s 后回读首份合同', async code => {
    if (code === 'P2034') {
      mocks.contractFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(stored)
    } else {
      mocks.contractFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(stored)
    }
    mocks.sourceFindMany.mockResolvedValue([{
      id: 'source-1', productId: 'product-1', supplierSku: null, purchaseUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, minOrderQty: 1, leadTimeDays: 0,
      product: { code: 'P001', name: '菌菇', spec: 'kg', inventoryUnit: 'kg', unit: 'kg' },
    }])
    mocks.transaction.mockRejectedValue(Object.assign(new Error('conflict'), { code }))

    const response = await app.inject({ method: 'POST', url: '/api/upstream/contracts', payload: rawPayload })
    expect(response.statusCode).toBe(200)
    expect(response.headers['idempotent-replay']).toBe('true')
    expect(response.json().id).toBe('contract-1')
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
})
