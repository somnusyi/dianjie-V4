import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import { loadAllProductCatalog } from './load-product-catalog'

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
