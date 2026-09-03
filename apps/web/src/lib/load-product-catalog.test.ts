import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import {
  loadAllProductCatalog,
  loadAllWarehouseProductCatalog,
} from './load-product-catalog'
import {
  matchesWarehouseProductSearch,
  type RevisionCatalogProduct,
} from './supplier-revision-cost-pricing'

const mockedApiFetch = vi.mocked(apiFetch)

describe('loadAllProductCatalog', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('loads every page and keeps one row per product id', async () => {
    const products = Array.from({ length: 205 }, (_, index) => ({ id: `p${index}`, status: 'ENABLED' }))
    mockedApiFetch
      .mockResolvedValueOnce({ items: products.slice(0, 100), total: 205 })
      .mockResolvedValueOnce({ items: products.slice(100, 200), total: 205 })
      .mockResolvedValueOnce({ items: products.slice(200), total: 205 })

    const result = await loadAllProductCatalog('supplier-1')
    expect(result).toHaveLength(205)
    expect(mockedApiFetch).toHaveBeenNthCalledWith(1, '/api/products?supplierId=supplier-1&page=1&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(2, '/api/products?supplierId=supplier-1&page=2&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(3, '/api/products?supplierId=supplier-1&page=3&pageSize=100')
    expect(mockedApiFetch).toHaveBeenCalledTimes(3)
  })

  it('keeps fetching full pages without a total and deduplicates page-boundary rows', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, status: 'ENABLED' }))
    mockedApiFetch
      .mockResolvedValueOnce({ items: first })
      .mockResolvedValueOnce({ items: [{ id: 'p99', status: 'ENABLED' }, { id: 'p100', status: 'ENABLED' }] })

    const result = await loadAllProductCatalog()

    expect(result).toHaveLength(101)
    expect(mockedApiFetch).toHaveBeenNthCalledWith(1, '/api/products?page=1&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(2, '/api/products?page=2&pageSize=100')
    expect(mockedApiFetch).toHaveBeenCalledTimes(2)
  })
})

describe('loadAllWarehouseProductCatalog', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset()
  })

  it('loads every warehouse page and intersects it with the complete supplier catalog', async () => {
    const firstWarehousePage = Array.from({ length: 100 }, (_, index) => ({ id: `stock-${index}` }))
    const firstCatalogPage = Array.from({ length: 100 }, (_, index) => ({
      id: index === 10 ? 'stock-10' : `catalog-${index}`,
      status: 'ENABLED',
    }))
    mockedApiFetch
      .mockResolvedValueOnce({ items: firstWarehousePage, total: 102, totalPages: 2 })
      .mockResolvedValueOnce({ items: [{ id: 'stock-100' }, { id: 'stock-101' }], total: 102, totalPages: 2 })
      .mockResolvedValueOnce({ items: firstCatalogPage, total: 102 })
      .mockResolvedValueOnce({
        items: [
          { id: 'stock-101', status: 'ENABLED' },
          { id: 'catalog-only', status: 'ENABLED' },
        ],
        total: 102,
      })

    const result = await loadAllWarehouseProductCatalog('supplier / 一')

    expect(result.map(product => product.id)).toEqual(['stock-10', 'stock-101'])
    expect(mockedApiFetch).toHaveBeenNthCalledWith(1, '/api/warehouse-inventory?scope=stock&page=1&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(2, '/api/warehouse-inventory?scope=stock&page=2&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(3, '/api/products?supplierId=supplier%20%2F%20%E4%B8%80&page=1&pageSize=100')
    expect(mockedApiFetch).toHaveBeenNthCalledWith(4, '/api/products?supplierId=supplier%20%2F%20%E4%B8%80&page=2&pageSize=100')
  })

  it('deduplicates warehouse ids and preserves supplier catalog ordering', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({
        items: [{ id: 'stock-b' }, { id: 'stock-a' }, { id: 'stock-b' }, { id: null }],
        total: 4,
        totalPages: 1,
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'stock-a', status: 'ENABLED' },
          { id: 'not-in-warehouse', status: 'ENABLED' },
          { id: 'stock-b', status: 'ENABLED' },
        ],
        total: 3,
      })

    const result = await loadAllWarehouseProductCatalog('supplier-1')

    expect(result.map(product => product.id)).toEqual(['stock-a', 'stock-b'])
  })

  it('returns an empty catalog without loading supplier products when warehouse stock is empty', async () => {
    mockedApiFetch.mockResolvedValueOnce({ items: [], total: 0, totalPages: 1 })

    await expect(loadAllWarehouseProductCatalog('supplier-1')).resolves.toEqual([])
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/warehouse-inventory?scope=stock&page=1&pageSize=100')
  })

  it('fails closed when warehouse inventory cannot be loaded', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('仓库库存加载失败'))

    await expect(loadAllWarehouseProductCatalog('supplier-1')).rejects.toThrow('仓库库存加载失败')
    expect(mockedApiFetch).toHaveBeenCalledTimes(1)
    expect(mockedApiFetch.mock.calls.some(([path]) => String(path).startsWith('/api/products'))).toBe(false)
  })

  it('propagates supplier catalog failures instead of returning warehouse-only rows', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({ items: [{ id: 'stock-1' }], total: 1, totalPages: 1 })
      .mockRejectedValueOnce(new Error('供应商目录加载失败'))

    await expect(loadAllWarehouseProductCatalog('supplier-1')).rejects.toThrow('供应商目录加载失败')
  })
})

describe('matchesWarehouseProductSearch', () => {
  const product: RevisionCatalogProduct = {
    id: 'product-1',
    code: 'VEG-ABC-001',
    name: '七彩土豆',
    spec: '3KG / 箱',
    category: '新鲜蔬菜',
    status: 'ENABLED',
  }

  it.each([
    ['', true],
    ['   ', true],
    ['彩土', true],
    ['abc-00', false],
    ['3kg', false],
    ['鲜蔬', false],
    ['VEG', false],
    ['海菜花', false],
  ])('matches only a product-name substring: %j', (query, expected) => {
    expect(matchesWarehouseProductSearch(product, query)).toBe(expected)
  })

  it('treats the trimmed query as one literal name substring', () => {
    expect(matchesWarehouseProductSearch(product, '  七彩土豆 ')).toBe(true)
    expect(matchesWarehouseProductSearch(product, '七彩 土豆')).toBe(false)
  })

  it('handles absent optional searchable fields without matching stringified null values', () => {
    const sparse = { ...product, code: null, spec: null, category: null }
    expect(matchesWarehouseProductSearch(sparse, '土豆')).toBe(true)
    expect(matchesWarehouseProductSearch(sparse, 'null')).toBe(false)
  })
})
