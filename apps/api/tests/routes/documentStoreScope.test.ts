import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentRoutes } from '../../src/routes/documents'

const mocks = vi.hoisted(() => ({
  findSteps: vi.fn(),
  findDocument: vi.fn(),
  findStore: vi.fn(),
  findReceipt: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      documentStep: { findMany: mocks.findSteps },
      document: { findFirst: mocks.findDocument },
      store: { findFirst: mocks.findStore },
      receipt: { findFirst: mocks.findReceipt },
    },
  }
})

async function appFor(role: string, storeIds = ['store-1']) {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => {
    req.user = { tenantId: 'tenant-1', role, userId: 'user-1', storeId: 'store-1', storeIds }
  })
  await app.register(documentRoutes, { prefix: '/api/documents' })
  await app.ready()
  return app
}

describe('document store scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findSteps.mockResolvedValue([])
    mocks.findStore.mockResolvedValue({ id: 'store-1' })
    mocks.findReceipt.mockResolvedValue({ storeId: 'store-2' })
    mocks.findDocument.mockResolvedValue({
      id: 'doc-1', tenantId: 'tenant-1', storeId: 'store-2', initiatorId: 'user-1',
      steps: [], decisions: [], payload: {}, type: 'OTHER',
    })
  })

  it.each(['MANAGER', 'CHEF', 'PURCHASER', 'STAFF'])('%s cannot read another store document even as initiator', async role => {
    const app = await appFor(role)
    try {
      expect((await app.inject('/api/documents/doc-1')).statusCode).toBe(403)
      expect((await app.inject('/api/documents/doc-1/preview')).statusCode).toBe(403)
      expect((await app.inject('/api/documents/inbox')).statusCode).toBe(200)
      expect(mocks.findSteps.mock.calls[0][0].where.document.storeId).toEqual({ in: ['store-1'] })
      expect((await app.inject({
        method: 'POST', url: '/api/documents',
        payload: { type: 'OTHER', title: '越界单据', storeId: 'store-2' },
      })).statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('keeps group document access for the boss', async () => {
    const app = await appFor('BOSS')
    try {
      expect((await app.inject('/api/documents/doc-1')).statusCode).toBe(200)
      await app.inject('/api/documents/inbox')
      expect(mocks.findSteps.mock.calls[0][0].where.document.storeId).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('allows a manager to open a document from an assigned second store', async () => {
    const app = await appFor('MANAGER', ['store-1', 'store-2'])
    try {
      expect((await app.inject('/api/documents/doc-1')).statusCode).toBe(200)
      expect((await app.inject('/api/documents/doc-1/preview')).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('rejects a correction targeting a different store receipt', async () => {
    const app = await appFor('MANAGER')
    try {
      const response = await app.inject({ method: 'POST', url: '/api/documents', payload: {
        type: 'RECEIPT_CORRECTION', title: '更正', storeId: 'store-1', payload: { receiptId: 'receipt-2' },
      } })
      expect(response.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('rejects a group document pointing at another tenant store', async () => {
    mocks.findStore.mockResolvedValue(null)
    const app = await appFor('BOSS')
    try {
      const response = await app.inject({ method: 'POST', url: '/api/documents', payload: {
        type: 'OTHER', title: '单据', storeId: 'foreign-store',
      } })
      expect(response.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
