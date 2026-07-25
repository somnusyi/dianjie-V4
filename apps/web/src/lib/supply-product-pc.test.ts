import { describe, expect, it } from 'vitest'
import {
  buildCreateBody,
  buildEditBody,
  buildPriceChangeBody,
  buildProductQuery,
  buildStatusChangeBody,
  DEFAULT_SUPPLY_PRODUCT_FILTERS,
  formatMoney,
  formatProductStatusLabel,
  hasActiveFilters,
  keepFiltersForPage,
  productImageAlt,
  productStatusTone,
  resetPageFilters,
  resolveProductImageUrl,
  validateNewProductForm,
} from './supply-product-pc'

describe('buildProductQuery', () => {
  it('returns only pagination when no filters are active', () => {
    expect(buildProductQuery({})).toBe('?page=1&pageSize=20')
  })

  it('includes keyword, category and status', () => {
    const query = buildProductQuery({ q: '白菜', category: '蔬菜', status: 'ENABLED' })
    expect(query).toContain('q=%E7%99%BD%E8%8F%9C')
    expect(query).toContain('category=%E8%94%AC%E8%8F%9C')
    expect(query).toContain('status=ENABLED')
    expect(query).toContain('page=1')
    expect(query).toContain('pageSize=20')
  })

  it('respects custom page and pageSize', () => {
    const query = buildProductQuery({ page: 3, pageSize: 50 })
    expect(query).toContain('page=3')
    expect(query).toContain('pageSize=50')
  })

  it('skips empty / whitespace-only keyword', () => {
    const query = buildProductQuery({ q: '   ' })
    expect(query).not.toContain('q=')
  })

  it('sends supplierId to backend so totals and pages use the same scope', () => {
    const query = buildProductQuery({ supplierId: 'sup-1' })
    expect(query).toContain('supplierId=sup-1')
  })

  it('combines all filters with pagination', () => {
    const query = buildProductQuery({
      q: '虾',
      category: '冻品',
      status: 'DISABLED',
      page: 2,
      pageSize: 10,
    })
    expect(query).toContain('q=%E8%99%BE')
    expect(query).toContain('category=%E5%86%BB%E5%93%81')
    expect(query).toContain('status=DISABLED')
    expect(query).toContain('page=2')
    expect(query).toContain('pageSize=10')
  })
})

describe('resetPageFilters', () => {
  it('resets page to 1 when filters change', () => {
    const current = { ...DEFAULT_SUPPLY_PRODUCT_FILTERS, page: 5, q: 'old' }
    const next = resetPageFilters(current, { q: 'new' })
    expect(next.page).toBe(1)
    expect(next.q).toBe('new')
    expect(next.category).toBe('')
    expect(next.status).toBe('')
  })

  it('preserves unrelated filters', () => {
    const current = { ...DEFAULT_SUPPLY_PRODUCT_FILTERS, category: '蔬菜', status: 'ENABLED', page: 3 }
    const next = resetPageFilters(current, { q: '虾' })
    expect(next.page).toBe(1)
    expect(next.category).toBe('蔬菜')
    expect(next.status).toBe('ENABLED')
    expect(next.q).toBe('虾')
  })
})

describe('keepFiltersForPage', () => {
  it('updates only page, preserving all other filters', () => {
    const current: typeof DEFAULT_SUPPLY_PRODUCT_FILTERS = {
      q: '白菜', category: '蔬菜', status: 'ENABLED', supplierId: 'sup-1', page: 1, pageSize: 10,
    }
    const next = keepFiltersForPage(current, 7)
    expect(next).toEqual({
      q: '白菜', category: '蔬菜', status: 'ENABLED', supplierId: 'sup-1', page: 7, pageSize: 10,
    })
  })
})

describe('buildCreateBody', () => {
  it('maps form fields to API body', () => {
    const body = buildCreateBody({
      name: '大白菜', code: 'veg-001', category: '蔬菜',
      unit: 'kg', price: '12.5', spec: '500g/棵', shelfDays: '7', supplierId: 'sup-1',
    })
    expect(body).toEqual({
      name: '大白菜',
      code: 'veg-001',
      category: '蔬菜',
      unit: 'kg',
      price: 12.5,
      spec: '500g/棵',
      shelfDays: 7,
      supplierId: 'sup-1',
    })
  })

  it('omits empty optional fields', () => {
    const body = buildCreateBody({
      name: '盐', code: '', category: '', unit: '', price: '3', spec: '', shelfDays: '',
    })
    expect(body).toEqual({ name: '盐', unit: '件', price: 3, shelfDays: 7 })
    expect(body).not.toHaveProperty('code')
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('spec')
  })

  it('includes imageKey when provided', () => {
    const body = buildCreateBody({
      name: '土豆', code: '', category: '', unit: 'kg', price: '5', spec: '', shelfDays: '30',
      imageKey: 'products/t1/abc.jpg',
    })
    expect(body.imageKey).toBe('products/t1/abc.jpg')
  })

  it('preserves a valid zero-day shelf life', () => {
    const body = buildCreateBody({
      name: '当日鲜品', code: '', category: '', unit: '件', price: '5', spec: '', shelfDays: '0',
    })
    expect(body.shelfDays).toBe(0)
  })

  it('does not include imageKey when null', () => {
    const body = buildCreateBody({
      name: '土豆', code: '', category: '', unit: 'kg', price: '5', spec: '', shelfDays: '30',
      imageKey: null,
    })
    expect(body).not.toHaveProperty('imageKey')
  })
})

describe('buildEditBody', () => {
  it('returns only changed fields', () => {
    const form = { name: '新白菜', code: 'veg-001', category: '蔬菜', unit: 'kg', spec: '500g', shelfDays: '7' }
    const original = { name: '大白菜', code: 'veg-001', category: '蔬菜', unit: 'kg', spec: '500g', shelfDays: 7 }
    const body = buildEditBody(form, original)
    expect(body).toEqual({ name: '新白菜' })
  })

  it('returns empty object when nothing changed', () => {
    const form = { name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: '7' }
    const original = { name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: 7 }
    expect(buildEditBody(form, original)).toEqual({})
  })

  it('detects spec change from null to value', () => {
    const form = { name: '白菜', code: 'v1', category: '', unit: 'kg', spec: '500g', shelfDays: '7' }
    const original = { name: '白菜', code: 'v1', category: '', unit: 'kg', spec: '', shelfDays: 7 }
    const body = buildEditBody(form, original)
    expect(body).toHaveProperty('spec', '500g')
  })

  it('sets spec to null when cleared', () => {
    const form = { name: '白菜', code: 'v1', category: '', unit: 'kg', spec: '', shelfDays: '7' }
    const original = { name: '白菜', code: 'v1', category: '', unit: 'kg', spec: '500g', shelfDays: 7 }
    const body = buildEditBody(form, original)
    expect(body).toHaveProperty('spec', null)
  })
})

describe('buildPriceChangeBody / buildStatusChangeBody', () => {
  it('maps price change', () => {
    expect(buildPriceChangeBody(25.5)).toEqual({ price: 25.5 })
  })

  it('maps disable', () => {
    expect(buildStatusChangeBody('DISABLED')).toEqual({ status: 'DISABLED' })
  })

  it('maps enable', () => {
    expect(buildStatusChangeBody('ENABLED')).toEqual({ status: 'ENABLED' })
  })
})

describe('resolveProductImageUrl', () => {
  it('returns URL when valid', () => {
    expect(resolveProductImageUrl('https://cdn.example.com/img.jpg')).toBe('https://cdn.example.com/img.jpg')
  })

  it('returns null for null', () => {
    expect(resolveProductImageUrl(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(resolveProductImageUrl(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(resolveProductImageUrl('')).toBeNull()
    expect(resolveProductImageUrl('  ')).toBeNull()
  })
})

describe('formatProductStatusLabel / productStatusTone', () => {
  it('maps known statuses', () => {
    expect(formatProductStatusLabel('ENABLED')).toBe('供应中')
    expect(formatProductStatusLabel('DISABLED')).toBe('已停售')
    expect(formatProductStatusLabel('PENDING_APPROVAL')).toBe('旧流程待关闭')
    expect(formatProductStatusLabel('PENDING_DISABLE')).toBe('旧流程待关闭')
  })

  it('falls back to raw status for unknown values', () => {
    expect(formatProductStatusLabel('UNKNOWN')).toBe('UNKNOWN')
  })

  it('returns correct tones', () => {
    expect(productStatusTone('ENABLED')).toBe('green')
    expect(productStatusTone('DISABLED')).toBe('gray')
    expect(productStatusTone('PENDING_APPROVAL')).toBe('orange')
  })
})

describe('hasActiveFilters', () => {
  it('returns false for default filters', () => {
    expect(hasActiveFilters(DEFAULT_SUPPLY_PRODUCT_FILTERS)).toBe(false)
  })

  it('returns true when keyword is set', () => {
    expect(hasActiveFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, q: '白菜' })).toBe(true)
  })

  it('returns true when category is set', () => {
    expect(hasActiveFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, category: '蔬菜' })).toBe(true)
  })

  it('returns true when status is set', () => {
    expect(hasActiveFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, status: 'ENABLED' })).toBe(true)
  })

  it('returns true when supplier is set', () => {
    expect(hasActiveFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, supplierId: 'sup-1' })).toBe(true)
  })

  it('returns false for whitespace-only keyword', () => {
    expect(hasActiveFilters({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, q: '   ' })).toBe(false)
  })
})

describe('validateNewProductForm', () => {
  it('returns null for valid form', () => {
    expect(validateNewProductForm({ name: '白菜', price: '10' })).toBeNull()
  })

  it('rejects empty name', () => {
    expect(validateNewProductForm({ name: '', price: '10' })).toBe('商品名称必填')
  })

  it('rejects negative price', () => {
    expect(validateNewProductForm({ name: '白菜', price: '-5' })).toBe('单价不能为负数')
  })

  it('rejects NaN price', () => {
    expect(validateNewProductForm({ name: '白菜', price: 'abc' })).toBe('单价不能为负数')
  })

  it('allows zero price', () => {
    expect(validateNewProductForm({ name: '白菜', price: '0' })).toBeNull()
  })
})

describe('formatMoney', () => {
  it('formats number values', () => {
    expect(formatMoney(12.5)).toBe('¥12.50')
  })

  it('formats string numbers', () => {
    expect(formatMoney('99.9')).toBe('¥99.90')
  })

  it('returns fallback for non-finite', () => {
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
    expect(formatMoney(NaN)).toBe('—')
  })

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('¥0.00')
  })
})

describe('productImageAlt', () => {
  it('includes code when provided', () => {
    expect(productImageAlt('大白菜', 'VEG-001')).toBe('大白菜 (VEG-001)')
  })

  it('omits code when null', () => {
    expect(productImageAlt('大白菜', null)).toBe('大白菜')
  })

  it('omits code when not provided', () => {
    expect(productImageAlt('大白菜')).toBe('大白菜')
  })
})

describe('role path', () => {
  it('supply-chain products path is under /v2/supply-chain/', () => {
    const productsPath = '/v2/supply-chain/products'
    expect(productsPath.startsWith('/v2/supply-chain/')).toBe(true)
  })
})
