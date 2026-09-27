import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  notificationCreate: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: { $transaction: mocks.transaction },
  }
})

import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

describe('操作体验批次八跨角色对账衔接', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-1',
        userId: 'supplier-user-1',
        role: 'SUPPLIER_OWNER',
        supplierId: 'supplier-1',
      }
    })
    await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      upstreamSettlementStatement: {
        updateMany: mocks.updateMany,
        findUnique: mocks.findUnique,
      },
      notification: { create: mocks.notificationCreate },
    }))
    mocks.findUnique.mockResolvedValue({
      id: 'statement-1',
      no: 'USS202609000001',
      payableAmount: 1288.5,
      lines: [],
    })
    mocks.notificationCreate.mockResolvedValue({ id: 'notification-1' })
  })

  it('供应商确认状态与财务通知在同一事务中只写一次', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/upstream/settlement-statements/statement-1/confirm',
    })
    const replay = await app.inject({
      method: 'POST',
      url: '/api/upstream/settlement-statements/statement-1/confirm',
    })

    expect(confirmed.statusCode).toBe(200)
    expect(replay.statusCode).toBe(409)
    expect(mocks.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: 'statement-1', tenantId: 'tenant-1', supplierId: 'supplier-1', status: 'SENT_TO_SUPPLIER',
      }),
      data: expect.objectContaining({ status: 'CONFIRMED', supplierConfirmedById: 'supplier-user-1' }),
    }))
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1)
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recipientRole: 'FINANCE',
        type: 'UPSTREAM_SETTLEMENT_CONFIRMED',
        refId: 'statement-1',
        dedupeKey: 'UPSTREAM_SETTLEMENT:statement-1:CONFIRMED',
      }),
    })
  })
})
