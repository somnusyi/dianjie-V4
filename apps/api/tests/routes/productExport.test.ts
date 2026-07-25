import Fastify from 'fastify'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildProductExportCsv,
  buildProductKeywordWhere,
  buildProductListWhere,
  canExportProductCatalog,
  escapeCsv,
  ExportableProduct,
  formatProductStatus,
  parseProductQueryTokens,
  PRODUCT_EXPORT_MAX_ROWS,
  productExportFilename,
  productRoutes,
  sanitizeCsvCell,
} from '../../src/routes/products'

const tenantId = `tenant-export-test`
const supplierAId = `supplier-a-export-test`
const supplierBId = `supplier-b-export-test`

const mockFindMany = vi.fn()
const mockCategoryFindFirst = vi.fn()

vi.mock('@dianjie/db', () => ({
  prisma: {
    product: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
    supplierProductCategory: {
      findFirst: (...args: any[]) => mockCategoryFindFirst(...args),
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

  it('sanitizeCsvCell neutralizes formula injection prefixes while preserving content', () => {
    expect(sanitizeCsvCell('=cmd|')).toBe("'=cmd|")
    expect(sanitizeCsvCell('+1')).toBe("'+1")
    expect(sanitizeCsvCell('-1')).toBe("'-1")
    expect(sanitizeCsvCell('@sum(A1)')).toBe("'@sum(A1)")
    expect(sanitizeCsvCell('\t=1')).toBe("'\t=1")
    expect(sanitizeCsvCell('\n=1')).toBe("\"'\n=1\"")
    expect(sanitizeCsvCell('\r=1')).toBe("\"'\r=1\"")
    expect(sanitizeCsvCell('  =1')).toBe("'  =1")
    expect(sanitizeCsvCell('plain')).toBe('plain')
  })

  it('sanitizeCsvCell still applies RFC4180 escaping after neutralization', () => {
    expect(sanitizeCsvCell('=a,b')).toBe("\"'=a,b\"")
    expect(sanitizeCsvCell('  +1"2')).toBe("\"'  +1\"\"2\"")
  })

  it('formatProductStatus maps status codes to readable labels', () => {
    expect(formatProductStatus('ENABLED')).toBe('供应中')
    expect(formatProductStatus('DISABLED')).toBe('已停售')
    expect(formatProductStatus('PENDING_APPROVAL')).toBe('上架待审')
    expect(formatProductStatus('PENDING_DISABLE')).toBe('停售待审')
    expect(formatProductStatus('UNKNOWN')).toBe('UNKNOWN')
  })

  it('productExportFilename uses China business date (Asia/Shanghai)', () => {
    expect(productExportFilename(new Date('2026-07-25T10:38:55.883Z'))).toBe('商品报价表_2026-07-25.csv')
    expect(productExportFilename(new Date('2026-07-25T16:00:00.000Z'))).toBe('商品报价表_2026-07-26.csv')
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

  it('buildProductExportCsv neutralizes dangerous cell values', () => {
    const csv = buildProductExportCsv([{
      code: '=cmd|',
      name: '@sum(A1)',
      category: '蔬菜',
      spec: '\t=1+1',
      unit: '  +件',
      inventoryUnit: 'kg',
      price: 1,
      status: 'ENABLED',
    }])
    const line = csv.split('\r\n').find(l => l.includes("'=cmd|"))!
    expect(line).toContain("'=cmd|")
    expect(line).toContain("'@sum(A1)")
    expect(line).toContain("'\t=1+1")
    expect(line).toContain("'  +件")
  })

  it('parseProductQueryTokens splits on whitespace and lowercases', () => {
    expect(parseProductQueryTokens('  白菜  500g ')).toEqual(['白菜', '500g'])
    expect(parseProductQueryTokens('')).toEqual([])
    expect(parseProductQueryTokens(undefined)).toEqual([])
  })

  it('buildProductKeywordWhere returns undefined for empty tokens', () => {
    expect(buildProductKeywordWhere([])).toBeUndefined()
  })

  it('buildProductKeywordWhere builds OR clause for a single token', () => {
    expect(buildProductKeywordWhere(['白菜'])).toEqual({
      OR: [
        { name: { contains: '白菜', mode: 'insensitive' } },
        { code: { contains: '白菜', mode: 'insensitive' } },
        { spec: { contains: '白菜', mode: 'insensitive' } },
      ],
    })
  })

  it('buildProductKeywordWhere builds AND of ORs for multiple tokens', () => {
    expect(buildProductKeywordWhere(['白菜', '500g'])).toEqual({
      AND: [
        {
          OR: [
            { name: { contains: '白菜', mode: 'insensitive' } },
            { code: { contains: '白菜', mode: 'insensitive' } },
            { spec: { contains: '白菜', mode: 'insensitive' } },
          ],
        },
        {
          OR: [
            { name: { contains: '500g', mode: 'insensitive' } },
            { code: { contains: '500g', mode: 'insensitive' } },
            { spec: { contains: '500g', mode: 'insensitive' } },
          ],
        },
      ],
    })
  })

  it('canExportProductCatalog allows SUPPLY_CHAIN and supplier-domain roles only', () => {
    expect(canExportProductCatalog('SUPPLY_CHAIN')).toBe(true)
    expect(canExportProductCatalog('SUPPLIER_OWNER')).toBe(true)
    expect(canExportProductCatalog('SUPPLIER_STAFF')).toBe(true)
    expect(canExportProductCatalog('SUPPLIER_SUB')).toBe(true)
    expect(canExportProductCatalog('ADMIN')).toBe(false)
    expect(canExportProductCatalog('FINANCE')).toBe(false)
    expect(canExportProductCatalog('ENGINEERING')).toBe(false)
    expect(canExportProductCatalog('MANAGER')).toBe(false)
    expect(canExportProductCatalog('CHEF')).toBe(false)
    expect(canExportProductCatalog('KITCHEN_LEAD')).toBe(false)
    expect(canExportProductCatalog('UNKNOWN')).toBe(false)
    expect(canExportProductCatalog(undefined)).toBe(false)
    expect(canExportProductCatalog(null)).toBe(false)
  })
})

describe('buildProductListWhere', () => {
  function req(query: Record<string, unknown>, user: Record<string, unknown>) {
    return { query, user: { tenantId, ...user } }
  }

  afterEach(() => {
    mockCategoryFindFirst.mockReset()
  })

  it('returns tenant-scoped where with filters', async () => {
    const result = await buildProductListWhere(req({ category: '蔬菜', status: 'ENABLED', q: '白菜' }, { role: 'ADMIN' }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({
      tenantId,
      category: '蔬菜',
      status: 'ENABLED',
      AND: [
        {
          OR: [
            { name: { contains: '白菜', mode: 'insensitive' } },
            { code: { contains: '白菜', mode: 'insensitive' } },
            { spec: { contains: '白菜', mode: 'insensitive' } },
          ],
        },
      ],
    })
  })

  it('applies multi-token q semantics (AND across name/code/spec)', async () => {
    const result = await buildProductListWhere(req({ q: '白菜  500g' }, { role: 'ADMIN' }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({
      tenantId,
      AND: [
        {
          AND: [
            {
              OR: [
                { name: { contains: '白菜', mode: 'insensitive' } },
                { code: { contains: '白菜', mode: 'insensitive' } },
                { spec: { contains: '白菜', mode: 'insensitive' } },
              ],
            },
            {
              OR: [
                { name: { contains: '500g', mode: 'insensitive' } },
                { code: { contains: '500g', mode: 'insensitive' } },
                { spec: { contains: '500g', mode: 'insensitive' } },
              ],
            },
          ],
        },
      ],
    })
  })

  it('resolves categoryId to category name and keeps category compat', async () => {
    mockCategoryFindFirst.mockResolvedValue({ id: 'cat-1', name: '蔬菜' })
    const result = await buildProductListWhere(req({ categoryId: 'cat-1' }, { role: 'ADMIN' }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, category: '蔬菜' })
    expect(mockCategoryFindFirst).toHaveBeenCalledWith({ where: { id: 'cat-1', tenantId } })
  })

  it('rejects invalid categoryId instead of silently ignoring', async () => {
    mockCategoryFindFirst.mockResolvedValue(null)
    const result = await buildProductListWhere(req({ categoryId: 'missing' }, { role: 'ADMIN' }))
    expect(result.error).toEqual({ statusCode: 400, message: '商品分类不存在' })
  })

  it('scopes categoryId resolution to supplier for supplier roles', async () => {
    mockCategoryFindFirst.mockResolvedValue({ id: 'cat-s', name: '冻品' })
    const result = await buildProductListWhere(req({ categoryId: 'cat-s' }, { role: 'SUPPLIER_OWNER', supplierId: supplierAId }))
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, supplierId: supplierAId, category: '冻品' })
    expect(mockCategoryFindFirst).toHaveBeenCalledWith({ where: { id: 'cat-s', tenantId, supplierId: supplierAId } })
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

  it('lets internal supply chain filter the tenant catalog by supplierId', async () => {
    const result = await buildProductListWhere(
      req({ supplierId: supplierBId }, { role: 'SUPPLY_CHAIN' }),
    )
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({ tenantId, supplierId: supplierBId })
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
      const map: Record<string, any> = {
        'supply-chain': { tenantId, userId: 'sc', role: 'SUPPLY_CHAIN' },
        admin: { tenantId, userId: 'admin', role: 'ADMIN' },
        finance: { tenantId, userId: 'fin', role: 'FINANCE' },
        engineering: { tenantId, userId: 'eng', role: 'ENGINEERING' },
        manager: { tenantId, userId: 'mgr', role: 'MANAGER', storeId: 's1', storeIds: ['s1'] },
        chef: { tenantId, userId: 'chef', role: 'CHEF_DIRECTOR' },
        'supplier-b': { tenantId, supplierId: supplierBId, userId: 'user-b', role: 'SUPPLIER_OWNER' },
        'supplier-a': { tenantId, supplierId: supplierAId, userId: 'user-a', role: 'SUPPLIER_OWNER' },
      }
      request.user = map[actor] || { tenantId, userId: actor, role: actor }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  afterEach(() => {
    mockFindMany.mockReset()
    mockCategoryFindFirst.mockReset()
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

  it('applies multi-token q search to the export', async () => {
    mockFindMany.mockResolvedValue([])
    await app.inject({
      method: 'GET',
      url: `/api/products/export.csv?q=${encodeURIComponent('白菜 500g')}`,
      headers: { 'x-test-actor': 'supply-chain' },
    })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.AND).toHaveLength(1)
    expect(where.AND[0].AND).toHaveLength(2)
    expect(where.AND[0].AND[0].OR).toEqual([
      { name: { contains: '白菜', mode: 'insensitive' } },
      { code: { contains: '白菜', mode: 'insensitive' } },
      { spec: { contains: '白菜', mode: 'insensitive' } },
    ])
  })

  it('resolves categoryId and filters by category name', async () => {
    mockCategoryFindFirst.mockResolvedValue({ id: 'cat-1', name: '蔬菜' })
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv?categoryId=cat-1',
      headers: { 'x-test-actor': 'supply-chain' },
    })
    expect(response.statusCode).toBe(200)
    expect(mockCategoryFindFirst).toHaveBeenCalledWith({ where: { id: 'cat-1', tenantId } })
    expect(mockFindMany.mock.calls[0][0].where).toMatchObject({ tenantId, category: '蔬菜' })
  })

  it('returns 400 for invalid categoryId', async () => {
    mockCategoryFindFirst.mockResolvedValue(null)
    const response = await app.inject({
      method: 'GET',
      url: '/api/products/export.csv?categoryId=missing',
      headers: { 'x-test-actor': 'supply-chain' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('商品分类不存在')
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

  it('neutralizes formula injection in the response', async () => {
    mockFindMany.mockResolvedValue([
      { code: '=cmd|', name: '@sum(A1)', category: '蔬菜', spec: '\t=1+1', unit: '件', inventoryUnit: 'kg', price: 1, status: 'ENABLED' },
    ])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv' })
    const body = csvBody(response)
    const dataLine = body.split('\r\n').find(line => line.includes("'=cmd|"))!
    expect(dataLine).toContain("'=cmd|")
    expect(dataLine).toContain("'@sum(A1)")
    expect(dataLine).toContain("'\t=1+1")
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

  it('rejects FINANCE role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'finance' } })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toContain('无权')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('rejects ENGINEERING role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'engineering' } })
    expect(response.statusCode).toBe(403)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('rejects store role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'manager' } })
    expect(response.statusCode).toBe(403)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('rejects ADMIN role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'admin' } })
    expect(response.statusCode).toBe(403)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('rejects unknown role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'random-role' } })
    expect(response.statusCode).toBe(403)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('allows internal SUPPLY_CHAIN role', async () => {
    mockFindMany.mockResolvedValue([])
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'supply-chain' } })
    expect(response.statusCode).toBe(200)
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ tenantId })
  })

  it('returns 400 when export exceeds the hard row cap', async () => {
    mockFindMany.mockResolvedValue(
      Array(PRODUCT_EXPORT_MAX_ROWS + 1).fill({
        code: 'P-CAP', name: 'cap', category: '蔬菜', spec: '', unit: '件', inventoryUnit: 'kg', price: 1, status: 'ENABLED',
      }),
    )
    const response = await app.inject({ method: 'GET', url: '/api/products/export.csv', headers: { 'x-test-actor': 'supply-chain' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain(String(PRODUCT_EXPORT_MAX_ROWS))
    expect(response.json().error).toContain('缩小筛选范围')
    expect(mockFindMany.mock.calls[0][0].take).toBe(PRODUCT_EXPORT_MAX_ROWS + 1)
  })
})
