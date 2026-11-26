import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ voidDoc: vi.fn() }))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return { ...actual, prisma: { warehouseDoc: { findFirst: vi.fn() } } }
})
vi.mock('../../src/services/warehouseDocs', () => ({
  confirmWarehouseDoc: vi.fn(), reviewWarehouseDoc: vi.fn(), unreviewWarehouseDoc: vi.fn(),
  editWarehouseDoc: vi.fn(), unconfirmWarehouseDoc: vi.fn(),
  normalizeWarehouseDocAttachments: vi.fn().mockReturnValue([]),
  voidWarehouseInboundDoc: (...args: any[]) => mocks.voidDoc(...args),
}))
vi.mock('../../src/routes/upload', () => ({ signOssKey: vi.fn() }))

import { warehouseDocsRoutes } from '../../src/routes/warehouseDocs'

function buildApp(role: string) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { tenantId: 'tenant-1', userId: 'actor-1', role } })
  app.register(warehouseDocsRoutes)
  return app
}

describe('warehouse document void route', () => {
  beforeEach(() => {
    mocks.voidDoc.mockReset().mockResolvedValue({ changed: true, doc: { status: 'VOIDED' } })
  })

  it('allows supply chain and forwards a required reason', async () => {
    const response = await buildApp('SUPPLY_CHAIN').inject({ method: 'POST', url: '/doc-1/void', payload: { reason: '数量录入错误' } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ ok: true, changed: true, status: 'VOIDED' })
    expect(mocks.voidDoc).toHaveBeenCalledWith({ tenantId: 'tenant-1', userId: 'actor-1', docId: 'doc-1', reason: '数量录入错误' })
  })

  it.each(['FINANCE', 'PURCHASER', 'ADMIN'])('rejects %s before calling the service', async role => {
    const response = await buildApp(role).inject({ method: 'POST', url: '/doc-1/void', payload: { reason: '数量录入错误' } })
    expect(response.statusCode).toBe(403)
    expect(mocks.voidDoc).not.toHaveBeenCalled()
  })

  it('rejects a missing or one-character reason', async () => {
    for (const payload of [{}, { reason: '错' }]) {
      const response = await buildApp('SUPPLY_CHAIN').inject({ method: 'POST', url: '/doc-1/void', payload })
      expect(response.statusCode).toBe(400)
    }
    expect(mocks.voidDoc).not.toHaveBeenCalled()
  })
})
