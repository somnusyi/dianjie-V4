import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProductExportUrl,
  downloadBlob,
  downloadProductExport,
  type ProductExportDownloader,
  type ProductExportFilters,
} from './export-products'

describe('buildProductExportUrl', () => {
  it('returns the base CSV path when all filters are empty', () => {
    const url = buildProductExportUrl({ searchQ: '', categoryFilter: '', statusFilter: '' })
    expect(url).toBe('/api/products/export.csv')
  })

  it('omits whitespace-only search query', () => {
    const url = buildProductExportUrl({ searchQ: '   ', categoryFilter: '', statusFilter: '' })
    expect(url).toBe('/api/products/export.csv')
  })

  it('includes non-empty filters', () => {
    const url = buildProductExportUrl({ searchQ: '蘑菇', categoryFilter: '菌类', statusFilter: 'ENABLED' })
    expect(url).toContain('q=%E8%98%91%E8%8F%87')
    expect(url).toContain('category=%E8%8F%8C%E7%B1%BB')
    expect(url).toContain('status=ENABLED')
    expect(url.startsWith('/api/products/export.csv?')).toBe(true)
  })

  it('trims the search query', () => {
    const url = buildProductExportUrl({ searchQ: '  beer  ', categoryFilter: '', statusFilter: '' })
    expect(url).toBe('/api/products/export.csv?q=beer')
  })

  it('encodes special characters', () => {
    const url = buildProductExportUrl({ searchQ: 'a&b=c', categoryFilter: '', statusFilter: '' })
    expect(url).toBe('/api/products/export.csv?q=a%26b%3Dc')
  })
})

describe('downloadBlob', () => {
  let anchor: any
  let body: any
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    anchor = {
      click: vi.fn(),
      remove: vi.fn(),
    }
    Object.defineProperty(anchor, 'href', { value: '', writable: true })
    Object.defineProperty(anchor, 'download', { value: '', writable: true })

    body = { appendChild: vi.fn(), removeChild: vi.fn() }
    createObjectURL = vi.fn().mockReturnValue('blob:test-url')
    revokeObjectURL = vi.fn()

    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body })
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates an object URL, clicks an anchor with the given filename, then cleans up', () => {
    const blob = new Blob(['a,b', '1,2'], { type: 'text/csv' })
    downloadBlob(blob, '报价表.csv')

    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(document.createElement).toHaveBeenCalledWith('a')
    expect(anchor.href).toBe('blob:test-url')
    expect(anchor.download).toBe('报价表.csv')
    expect(body.appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalled()
    expect(anchor.remove).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
  })
})

describe('downloadProductExport', () => {
  const filters: ProductExportFilters = {
    searchQ: 'green',
    categoryFilter: 'vegetable',
    statusFilter: 'ENABLED',
  }

  let downloader: ProductExportDownloader
  let anchor: any
  let body: any
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    downloader = vi.fn().mockResolvedValue({
      blob: new Blob(['csv,data'], { type: 'text/csv' }),
      filename: 'server-name.csv',
    })

    anchor = {
      click: vi.fn(),
      remove: vi.fn(),
    }
    Object.defineProperty(anchor, 'href', { value: '', writable: true })
    Object.defineProperty(anchor, 'download', { value: '', writable: true })

    body = { appendChild: vi.fn(), removeChild: vi.fn() }
    createObjectURL = vi.fn().mockReturnValue('blob:mock')
    revokeObjectURL = vi.fn()

    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body })
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the export with the built URL and uses the server filename', async () => {
    await downloadProductExport(filters, downloader)

    expect(downloader).toHaveBeenCalledWith(
      '/api/products/export.csv?q=green&category=vegetable&status=ENABLED',
      '商品报价表.csv',
    )
    expect(anchor.download).toBe('server-name.csv')
    expect(anchor.click).toHaveBeenCalled()
  })

  it('throws a friendly error when the download fails', async () => {
    const error = new Error('网络错误')
    downloader = vi.fn().mockRejectedValue(error)

    await expect(downloadProductExport(filters, downloader)).rejects.toThrow('网络错误')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
