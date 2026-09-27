import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  signOssKey: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      product: { findMany: vi.fn() },
      warehouseDoc: {
        findMany: (...args: any[]) => mocks.findMany(...args),
        count: (...args: any[]) => mocks.count(...args),
        findFirst: (...args: any[]) => mocks.findFirst(...args),
      },
    },
  }
})

vi.mock('../../src/routes/upload', () => ({
  signOssKey: (key: string) => mocks.signOssKey(key),
}))

import { warehouseDocsRoutes, withoutWarehouseDocAttachmentKeys } from '../../src/routes/warehouseDocs'

const tenantId = 'tenant-attachment-read'
const rawKey = `warehouse-docs/${tenantId}/supplier-delivery.pdf`
const attachment = {
  key: rawKey,
  name: '供应商送货单.pdf',
  mime: 'application/pdf',
  size: 2048,
}

function buildApp() {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = { tenantId, userId: 'user-1', role: 'SUPPLY_CHAIN' }
  })
  app.register(warehouseDocsRoutes)
  return app
}

describe('warehouse document attachment read boundary', () => {
  beforeEach(() => {
    mocks.findMany.mockReset()
    mocks.count.mockReset()
    mocks.findFirst.mockReset()
    mocks.signOssKey.mockReset()
    mocks.count.mockResolvedValue(1)
    mocks.signOssKey.mockImplementation((key: string) => `https://signed.local/${encodeURIComponent(key)}`)
  })

  it('list returns only attachment count and never returns stored object metadata', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'doc-1', tenantId, docNo: 'MI-001', attachments: [attachment] }])
    const response = await buildApp().inject({ method: 'GET', url: '/' })

    expect(response.statusCode, response.body).toBe(200)
    const item = response.json().items[0]
    expect(item).toMatchObject({ id: 'doc-1', attachmentCount: 1 })
    expect(item).not.toHaveProperty('attachments')
    expect(JSON.stringify(item)).not.toContain(rawKey)
    expect(mocks.signOssKey).not.toHaveBeenCalled()
  })

  it('detail signs a tenant-scoped key but omits the durable key field', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'doc-1',
      tenantId,
      docNo: 'MI-001',
      attachments: [attachment],
      lines: [],
      logs: [],
    })
    const response = await buildApp().inject({ method: 'GET', url: '/doc-1' })

    expect(response.statusCode, response.body).toBe(200)
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'doc-1', tenantId },
    }))
    expect(mocks.signOssKey).toHaveBeenCalledWith(rawKey)
    expect(response.json()).toMatchObject({
      id: 'doc-1',
      attachmentCount: 1,
      attachments: [{
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        url: expect.stringContaining('https://signed.local/'),
      }],
    })
    expect(response.json().attachments[0]).not.toHaveProperty('key')
  })

  it('malformed or foreign attachment metadata is hidden without hiding the accounting document', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'doc-legacy',
      tenantId,
      docNo: 'MI-LEGACY',
      attachments: [{ ...attachment, key: 'warehouse-docs/another-tenant/leak.pdf' }],
      lines: [],
      logs: [],
    })
    const response = await buildApp().inject({ method: 'GET', url: '/doc-legacy' })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ id: 'doc-legacy', attachmentCount: 0, attachments: [] })
    expect(mocks.signOssKey).not.toHaveBeenCalled()
  })

  it('strips durable attachment keys from mutation responses', () => {
    expect(withoutWarehouseDocAttachmentKeys({ id: 'doc-1', status: 'POSTED', attachments: [attachment] }))
      .toEqual({ id: 'doc-1', status: 'POSTED' })
  })
})
