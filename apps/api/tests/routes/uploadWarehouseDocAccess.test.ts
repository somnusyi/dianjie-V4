import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { describe, expect, it, vi } from 'vitest'

const signatureUrl = vi.hoisted(() => vi.fn((key: string) => `http://oss.local/${encodeURIComponent(key)}?signed=1`))
const putObject = vi.hoisted(() => vi.fn(async () => ({ res: { status: 200 } })))
const headObject = vi.hoisted(() => vi.fn())
vi.mock('ali-oss', () => ({
  default: class MockOss {
    signatureUrl = signatureUrl
    put = putObject
    head = headObject
  },
}))

import { assertSupplierEvidenceObject, assertWarehouseDocumentObjects, uploadRoutes } from '../../src/routes/upload'

function buildApp(role: string, tenantId = 'tenant-a') {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = { tenantId, userId: 'user-1', role }
  })
  app.register(multipart, { limits: { fileSize: 55 * 1024 * 1024 } })
  app.register(uploadRoutes)
  return app
}

function multipartFile(name: string, mime: string, contents: Buffer) {
  const boundary = '----dianjie-warehouse-document-test'
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
  )
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([prefix, contents, suffix]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

describe('warehouse document signed URL access', () => {
  it.each(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER', 'SUPPLY_CHAIN'])('allows warehouse document readers: %s', async role => {
    const key = 'warehouse-docs/tenant-a/known.pdf'
    const response = await buildApp(role).inject({
      method: 'GET',
      url: `/upload/signed-url?key=${encodeURIComponent(key)}`,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().url).toContain('https://oss.local/')
  })

  it.each(['MANAGER', 'CHEF', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF'])('rejects non-readers even when they know a same-tenant key: %s', async role => {
    const response = await buildApp(role).inject({
      method: 'GET',
      url: '/upload/signed-url?key=warehouse-docs%2Ftenant-a%2Fknown.pdf',
    })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.json()).toEqual({ error: '无权查看采购入库随货单据' })
  })

  it('rejects another tenant key before signing', async () => {
    const response = await buildApp('ADMIN').inject({
      method: 'GET',
      url: '/upload/signed-url?key=warehouse-docs%2Ftenant-b%2Fknown.pdf',
    })
    expect(response.statusCode, response.body).toBe(403)
  })

  it.each(['supplier-archive-general', 'supplier-archive-sensitive'])('rejects generic signed-url for %s even for admin', async category => {
    const response = await buildApp('ADMIN').inject({
      method: 'GET',
      url: `/upload/signed-url?key=${encodeURIComponent(`${category}/tenant-a/known.pdf`)}`,
    })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.json().error).toContain('供应商档案记录')
  })

  it('rejects generic signed-url for supplier evidence even for admin', async () => {
    const response = await buildApp('ADMIN').inject({
      method: 'GET',
      url: '/upload/signed-url?key=supplier-evidence-documents%2Ftenant-a%2Fknown.pdf',
    })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.json().error).toContain('来货证明记录')
  })
})

describe('warehouse document multipart upload boundary', () => {
  it('uploads an allowed PDF for a warehouse writer and derives the object extension from MIME', async () => {
    putObject.mockClear()
    const body = multipartFile('supplier-note.exe', 'application/pdf', Buffer.from('pdf'))
    const response = await buildApp('SUPPLY_CHAIN').inject({
      method: 'POST', url: '/upload?category=warehouse-docs', ...body,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ name: 'supplier-note.exe', mime: 'application/pdf', size: 3 })
    expect(response.json().key).toMatch(/^warehouse-docs\/tenant-a\/.+\.pdf$/)
    expect(putObject).toHaveBeenCalledWith(response.json().key, expect.any(Buffer), expect.any(Object))
  })

  it('rejects a non-writer before storing the object', async () => {
    putObject.mockClear()
    const body = multipartFile('supplier-note.pdf', 'application/pdf', Buffer.from('pdf'))
    const response = await buildApp('MANAGER').inject({
      method: 'POST', url: '/upload?category=warehouse-docs', ...body,
    })
    expect(response.statusCode).toBe(403)
    expect(putObject).not.toHaveBeenCalled()
  })

  it('rejects disallowed MIME and image/PDF payloads above 10MB', async () => {
    putObject.mockClear()
    const text = multipartFile('note.txt', 'text/plain', Buffer.from('not allowed'))
    expect((await buildApp('ADMIN').inject({ method: 'POST', url: '/upload?category=warehouse-docs', ...text })).statusCode).toBe(400)

    const oversized = multipartFile('large.pdf', 'application/pdf', Buffer.alloc(10 * 1024 * 1024 + 1, 1))
    const response = await buildApp('ADMIN').inject({ method: 'POST', url: '/upload?category=warehouse-docs', ...oversized })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error).toContain('10MB')
    expect(putObject).not.toHaveBeenCalled()
  })
})

describe('supplier archive upload role boundary', () => {
  it('allows supply-chain to upload general archive but rejects sensitive archive', async () => {
    const general = multipartFile('license.pdf', 'application/pdf', Buffer.from('pdf'))
    expect((await buildApp('SUPPLY_CHAIN').inject({ method: 'POST', url: '/upload?category=supplier-archive-general', ...general })).statusCode).toBe(200)
    const sensitive = multipartFile('finance.pdf', 'application/pdf', Buffer.from('pdf'))
    expect((await buildApp('SUPPLY_CHAIN').inject({ method: 'POST', url: '/upload?category=supplier-archive-sensitive', ...sensitive })).statusCode).toBe(403)
  })

  it('allows finance to upload sensitive archive and rejects store roles', async () => {
    const finance = multipartFile('finance.pdf', 'application/pdf', Buffer.from('pdf'))
    expect((await buildApp('FINANCE').inject({ method: 'POST', url: '/upload?category=supplier-archive-sensitive', ...finance })).statusCode).toBe(200)
    const manager = multipartFile('license.pdf', 'application/pdf', Buffer.from('pdf'))
    expect((await buildApp('MANAGER').inject({ method: 'POST', url: '/upload?category=supplier-archive-general', ...manager })).statusCode).toBe(403)
  })
})

describe('supplier evidence upload boundary', () => {
  it.each(['SUPPLY_CHAIN', 'ADMIN'])('allows authorized evidence writer: %s', async role => {
    putObject.mockClear()
    const body = multipartFile('evidence.pdf', 'application/pdf', Buffer.from('pdf'))
    const response = await buildApp(role).inject({ method: 'POST', url: '/upload?category=supplier-evidence-documents', ...body })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().key).toMatch(/^supplier-evidence-documents\/tenant-a\/.+\.pdf$/)
    expect(putObject).toHaveBeenCalledTimes(1)
  })

  it.each(['FINANCE', 'MANAGER', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF'])('rejects unauthorized evidence writer without storing: %s', async role => {
    putObject.mockClear()
    const body = multipartFile('evidence.pdf', 'application/pdf', Buffer.from('pdf'))
    const response = await buildApp(role).inject({ method: 'POST', url: '/upload?category=supplier-evidence-documents', ...body })
    expect(response.statusCode, response.body).toBe(403)
    expect(putObject).not.toHaveBeenCalled()
  })
})

describe('warehouse document object verification', () => {
  const attachment = { key: 'warehouse-docs/tenant-a/known.pdf', name: '送货单.pdf', mime: 'application/pdf', size: 2048 }

  it('accepts an existing object only when actual MIME and size match', async () => {
    headObject.mockResolvedValueOnce({ res: { headers: { 'content-type': 'application/pdf', 'content-length': '2048' } } })
    await expect(assertWarehouseDocumentObjects('tenant-a', [attachment])).resolves.toBeUndefined()
    expect(headObject).toHaveBeenCalledWith(attachment.key)
  })

  it('rejects missing objects and mismatched object metadata', async () => {
    headObject.mockRejectedValueOnce({ status: 404, code: 'NoSuchKey' })
    await expect(assertWarehouseDocumentObjects('tenant-a', [attachment])).rejects.toMatchObject({ statusCode: 400 })

    headObject.mockResolvedValueOnce({ res: { headers: { 'content-type': 'image/png', 'content-length': '2048' } } })
    await expect(assertWarehouseDocumentObjects('tenant-a', [attachment])).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('supplier evidence object verification', () => {
  const attachment = { key: 'supplier-evidence-documents/tenant-a/known.pdf', name: '检测报告.pdf', mime: 'application/pdf', size: 2048 }

  it('rejects cross-tenant keys before OSS lookup', async () => {
    headObject.mockClear()
    await expect(assertSupplierEvidenceObject({ tenantId: 'tenant-b', attachment })).rejects.toMatchObject({ statusCode: 403 })
    expect(headObject).not.toHaveBeenCalled()
  })

  it('rejects missing objects', async () => {
    headObject.mockRejectedValueOnce({ status: 404, code: 'NoSuchKey' })
    await expect(assertSupplierEvidenceObject({ tenantId: 'tenant-a', attachment })).rejects.toMatchObject({ statusCode: 400 })
  })

  it.each([
    ['size', { 'content-type': 'application/pdf', 'content-length': '1024' }],
    ['mime', { 'content-type': 'image/png', 'content-length': '2048' }],
  ])('rejects %s metadata tampering', async (_label, headers) => {
    headObject.mockResolvedValueOnce({ res: { headers } })
    await expect(assertSupplierEvidenceObject({ tenantId: 'tenant-a', attachment })).rejects.toMatchObject({ statusCode: 400 })
  })
})
