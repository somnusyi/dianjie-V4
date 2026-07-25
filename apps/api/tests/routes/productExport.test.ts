import Fastify from 'fastify'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildProductExportCsv,
  buildProductListWhere,
  escapeCsv,
  ExportableProduct,
  formatProductStatus,
  productExportFilename,
  productRoutes,
} from '../../src/routes/products'

const tenantId = `tenant-export-test`
const supplierAId = `supplier-a-export-test`
const supplierBId = `supplier-b-export-test`

const mockFindMany = vi.fn()

vi.mock('@dianjie/db', () => ({
  prisma: {
    product: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
  },
}))

describe('product export helpers', () => {
  it('escapeCsv quotes fields containing comma, quote or newline', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"')
    expect(escapeCsv('a"b')).toBe('"a""b"')
    expect(escapeCsv('a\nb')).toBe('"a\nb"')
    expect(escapeCsv('a\rb')).toBe('"a\rb"')
    expect(escapeCsv('plain')).toBe('plain')
    expect(escapeCsv(null)).toBe('')
  })

  it('formatProductStatus maps status codes to readable labels', () => {
    expect(formatProductStatus('ENABLED')).toBe('供应中')
    expect(formatProductStatus('DISABLED')).toBe('已停售')
    expect(formatProductStatus('PENDING_APPROVAL')).toBe('上架待审')
    expect(formatProductStatus('PENDING_DISABLE')).toBe('停售待审')
    expect(formatProductStatus('UNKNOWN')).toBe('UNKNOWN')
  })

  it('productExportFilename contains date and csv extension', () => {
    const filename = productExportFilename()
    expect(filename).toMatch(/^商品报价表_\d{4}-\d{2}-\d{2}\.csv$/)
  })

  it('buildProductExportCsv builds UTF-8 ready body with header and rows', () => {
    const rows: ExportableProduct[] = [
      {
        code: 'P-001', name: '白菜', category: '蔬菜', spec: '500g',
        unit: '件', inventoryUnit: 'kg', price: 12.5, status: 'ENABLED',
      },
      {
        code: 'P-002', name: '带逗号, 引号"商品', category: '蔬菜', spec: '1kg',
        unit: '件', inventoryUnit: null, price: 0, status: 'PENDING_APPROVAL',
      },
    ]
    const csv = buildProductExportCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('商品编码,名称,分类,规格,采购单位,库存单位,采购价,状态')
    expect(lines[1]).toBe('P-001,白菜,蔬菜,500g,件,kg,12.50,供应中')
    expect(lines[2]).toContain('"带逗号, 引号""商品"')
  })
})

describe('buildProductListWhere', () => {
  function req(query: Record<string, unknown>, user: Record<string, unknown>) {
    return { query, user: { tenantId, ...user } }
  }

  it('returns tenant-scoped where with filters', async () => {
    const result = await buildProductListWhere(req({ category: '蔬菜', status: 'ENABLED', q: '白菜' }, { role: 'ADMIN' }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({
      tenantId,
      category: '蔬菜',
      status: 'ENABLED',
      OR: [
        { name: { contains: '白菜', mode: 'insensitive' } },
        { code: { contains: '白菜', mode: 'insensitive' } },
        { spec: { contains: '白菜', mode: 'insensitive' } },
      ],
    })
  })

  it('rejects invalid status', async () => {
    const result = await buildProductListWhere(req({ status: 'UNKNOWN' }, { role: 'ADMIN' }))
    expect(result.error).toBeDefined()
    expect(result.error?.statusCode).toBe(400)
  })

  it('scopes supplier owner to its own supplierId', async () => {
    const result = await buildProductListWhere(req({}, { role: 'SUPPLIER_OWNER', supplierId: supplierAId }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, supplierId: supplierAId })
  })

  it('rejects supplier without binding', async () => {
    const result = await buildProductListWhere(req({}, { role: 'SUPPLIER_OWNER', supplierId: null }))
    expect(result.error).toBeDefined()
    expect(result.error?.statusCode).toBe(403)
  })

  it('rejects supplier sub-account without catalog.read capability', async () => {
    const result = await buildProductListWhere(req({}, { role: 'SUPPLIER_SUB', supplierId: supplierAId }))
    expect(result.error).toBeDefined()
    expect(result.error?.statusCode).toBe(403)
  })

  it('limits store-scoped roles to ENABLED only', async () => {
    const result = await buildProductListWhere(req({ status: 'DISABLED' }, { role: 'KITCHEN_LEAD', storeId: 's1', storeIds: ['s1'] }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, status: 'ENABLED' })
  })

  it('does not accept tenantId or supplierId from query to expand scope', async () => {
    const result = await buildProductListWhere(
      req({ tenantId: 'other-tenant', supplierId: supplierBId }, { role: 'SUPPLIER_OWNER', supplierId: supplierAId }),
    )
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, supplierId: supplierAId })
  })
})

describe('GET /api/products/export.csv', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      const actor = String(request.headers['x-test-actor'] || 'supplier-a')
      if (actor === 'chef') {
        request.user = { tenantId, userId: 'chef', role: 'CHEF_DIRECTOR' }
      } else if (actor === 'supplier-b') {
        request.user = { tenantId, supplierId: supplierBId, userId: 'user-b', role: 'SUPPLIER_OWNER' }
      } else {
        request.user = { tenantId, supplierId: supplierAId, userId: 'user-a', role: 'SUPPLIER_OWNER' }
      }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  afterEach(() => {
    mockFindMany.mockReset()
  })

  function csvBody(response: { body: string }): string {
    return response.body.startsWith('\uFEFF') ? response.body.slice(1) : response.body
  }

  it('returns CSV with UTF-8 BOM and required headers', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.body.charCodeAt(0)).toBe(0xFEFF)
    expect(csvBody(response)).toContain('商品编码,名称,分类,规格,采购单位,库存单位,采购价,状态')
  })

  it('passes where clause built from filters to prisma', async () => {
    mockFindMany.mockResolvedValue([])
    await app.inject({
      method: 'GET',
      url: `/api/products/export.csv?category=${encodeURIComponent('蔬菜')}&status=ENABLED`,
    })
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const args = mockFindMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ tenantId, category: '蔬菜', status: 'ENABLED' })
  })

  it('scopes supplier A and returns only its rows', async () => {
    mockFindMany.mockResolvedValue([
      { code: 'A-001', name: 'A 商品', category: '蔬菜', spec: '', unit: '件', inventoryUnit: 'kg', price: 10, status: 'ENABLED' },
    ])
    const response = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv',
      headers: { 'x-test-actor': 'supplier-a' },
    })
    expect(response.statusCode).toBe(200)
    const body = csvBody(response)
    expect(body).toContain('A-001')
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ tenantId, supplierId: supplierAId })
  })

  it('scopes supplier B differently from supplier A', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv',
      headers: { 'x-test-actor': 'supplier-b' },
    })
    expect(response.statusCode).toBe(200)
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ tenantId, supplierId: supplierBId })
  })

  it('rejects invalid status with 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv?status=UNKNOWN' })
    expect(response.statusCode).toBe(400)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('escapes commas, quotes and newlines in the response', async () => {
    mockFindMany.mockResolvedValue([
      { code: 'P-001', name: '带逗号, 引号" 和换行\n商品', category: '蔬菜', spec: '', unit: '件', inventoryUnit: 'kg', price: 1, status: 'ENABLED' },
    ])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv' })
    const body = csvBody(response)
    const dataLine = body.split('\r\n').find(line => line.includes('P-001'))!
    expect(dataLine).toContain('"带逗号, 引号"" 和换行\n商品"')
  })

  it('sets a readable UTF-8 encoded filename', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv' })
    const disposition = String(response.headers['content-disposition'])
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('filename*=')
    expect(disposition).toContain(encodeURIComponent('商品报价表'))
    expect(disposition).toContain('.csv')
  })
})
