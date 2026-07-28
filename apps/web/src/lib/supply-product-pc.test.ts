import { describe, expect, it } from 'vitest'
import {
  buildCreateBody,
  buildEditBody,
  buildPriceChangeBody,
  buildProductCountQuery,
  buildProductQuery,
  buildStatusChangeBody,
  countProductsByCategory,
  DEFAULT_SUPPLY_PRODUCT_FILTERS,
  formatCostUnitPriceLabel,
  formatMoney,
  formatPriceChangeConfirmBody,
  formatProductQuantity,
  formatProductStatusLabel,
  hasActiveFilters,
  isNewCategoryName,
  keepFiltersForPage,
  parseProductQuantity,
  productImageAlt,
  productStatusTone,
  resetPageFilters,
  resolveProductImageUrl,
  validateNewProductForm,
  validateProductQuantities,
  validateProductQuantity,
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

describe('buildProductCountQuery', () => {
  it('returns empty string when no count-relevant filter is active', () => {
    expect(buildProductCountQuery({})).toBe('')
  })

  it('keeps status / supplier / keyword so counts share the list scope', () => {
    const query = buildProductCountQuery({ q: '虾', status: 'ENABLED', supplierId: 'sup-1' })
    expect(query).toContain('q=%E8%99%BE')
    expect(query).toContain('status=ENABLED')
    expect(query).toContain('supplierId=sup-1')
  })

  it('drops category and pagination so every category can be counted', () => {
    const query = buildProductCountQuery({
      category: '冻品',
      page: 3,
      pageSize: 50,
      status: 'DISABLED',
    })
    expect(query).not.toContain('category=')
    expect(query).not.toContain('page=')
    expect(query).not.toContain('pageSize=')
    expect(query).toContain('status=DISABLED')
  })

  it('skips whitespace-only keyword', () => {
    expect(buildProductCountQuery({ q: '   ' })).toBe('')
  })
})

describe('countProductsByCategory', () => {
  it('groups products by category', () => {
    expect(
      countProductsByCategory([
        { category: '蔬菜' },
        { category: '蔬菜' },
        { category: '菌类' },
      ]),
    ).toEqual({ 蔬菜: 2, 菌类: 1 })
  })

  it('buckets empty / null categories into 其他 to match backend', () => {
    expect(
      countProductsByCategory([{ category: null }, { category: '' }, { category: '蔬菜' }]),
    ).toEqual({ 其他: 2, 蔬菜: 1 })
  })

  it('returns empty object for empty list', () => {
    expect(countProductsByCategory([])).toEqual({})
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

describe('isNewCategoryName', () => {
  const existing = [
    { name: '蔬菜', count: 3 },
    { name: '冻品', count: 1 },
    { name: 'Vegetables', count: 0 },
  ]

  it('returns true for a name not in the existing list', () => {
    expect(isNewCategoryName('干货', existing)).toBe(true)
  })

  it('returns false for an exact existing name', () => {
    expect(isNewCategoryName('蔬菜', existing)).toBe(false)
    expect(isNewCategoryName('冻品', existing)).toBe(false)
  })

  it('returns false for empty or whitespace-only input', () => {
    expect(isNewCategoryName('', existing)).toBe(false)
    expect(isNewCategoryName('   ', existing)).toBe(false)
  })

  it('trims surrounding whitespace before comparing', () => {
    expect(isNewCategoryName('  蔬菜  ', existing)).toBe(false)
    expect(isNewCategoryName('  干货  ', existing)).toBe(true)
  })

  it('compares case-sensitively (keeps names as-is)', () => {
    expect(isNewCategoryName('vegetables', existing)).toBe(true)
    expect(isNewCategoryName('VEGETABLES', existing)).toBe(true)
    expect(isNewCategoryName('Vegetables', existing)).toBe(false)
  })

  it('treats any non-empty input as new when the list is empty', () => {
    expect(isNewCategoryName('蔬菜', [])).toBe(true)
    expect(isNewCategoryName('   ', [])).toBe(false)
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

describe('formatCostUnitPriceLabel', () => {
  it('includes the exact cost unit', () => {
    expect(formatCostUnitPriceLabel('斤')).toBe('单价（元 / 斤）')
    expect(formatCostUnitPriceLabel('500g')).toBe('单价（元 / 500g）')
  })

  it('falls back to generic term when cost unit is empty', () => {
    expect(formatCostUnitPriceLabel('')).toBe('单价（元 / 成本单位）')
  })
})

describe('formatPriceChangeConfirmBody', () => {
  it('states the exact cost unit and price change', () => {
    const body = formatPriceChangeConfirmBody(8, 9.5, '斤')
    expect(body).toContain('单价（元 / 斤）')
    expect(body).toContain('¥8.00')
    expect(body).toContain('¥9.50')
    expect(body).toContain('直接生效并通知总厨')
  })

  it('includes order unit hint when provided', () => {
    const body = formatPriceChangeConfirmBody(10, 12, '斤', '约 ¥5.00 / 500g')
    expect(body).toContain('单价（元 / 斤）')
    expect(body).toContain('约 ¥5.00 / 500g')
  })

  it('omits hint line when no order unit hint', () => {
    const body = formatPriceChangeConfirmBody(10, 12, '斤')
    expect(body.split('\n').length).toBe(3)
    expect(body).not.toContain('约 ¥')
  })
})

describe('parseProductQuantity', () => {
  it('accepts integer, two decimals and three decimals', () => {
    expect(parseProductQuantity('0')).toBe(0)
    expect(parseProductQuantity('12')).toBe(12)
    expect(parseProductQuantity('12.34')).toBe(12.34)
    expect(parseProductQuantity('0.001')).toBe(0.001)
    expect(parseProductQuantity('123.456')).toBe(123.456)
  })

  it('rejects empty and whitespace-only input', () => {
    expect(parseProductQuantity('')).toBeNull()
    expect(parseProductQuantity('   ')).toBeNull()
  })

  it('rejects negative numbers', () => {
    expect(parseProductQuantity('-1')).toBeNull()
    expect(parseProductQuantity('-0.001')).toBeNull()
  })

  it('rejects four or more decimals', () => {
    expect(parseProductQuantity('1.0001')).toBeNull()
    expect(parseProductQuantity('0.1234')).toBeNull()
  })

  it('rejects NaN, Infinity and scientific notation', () => {
    expect(parseProductQuantity('abc')).toBeNull()
    expect(parseProductQuantity('NaN')).toBeNull()
    expect(parseProductQuantity('Infinity')).toBeNull()
    expect(parseProductQuantity('1e-3')).toBeNull()
    expect(parseProductQuantity('2E2')).toBeNull()
  })

  it('rejects values above the database quantity limit', () => {
    expect(parseProductQuantity('999999999.999')).toBe(999999999.999)
    expect(parseProductQuantity('1000000000')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(parseProductQuantity('  5.5  ')).toBe(5.5)
  })
})

describe('validateProductQuantity', () => {
  it('returns null for valid non-negative values', () => {
    expect(validateProductQuantity('0', '库存')).toBeNull()
    expect(validateProductQuantity('0.001', '库存')).toBeNull()
    expect(validateProductQuantity('100.999', '库存')).toBeNull()
  })

  it('rejects empty values', () => {
    expect(validateProductQuantity('', '库存')).toBe('库存必填')
  })

  it('rejects negatives with explicit wording', () => {
    expect(validateProductQuantity('-1', '安全库存')).toBe('安全库存不能为负数')
  })

  it('rejects four decimals with explicit wording', () => {
    expect(validateProductQuantity('1.2345', '步长')).toBe('步长最多三位小数')
  })

  it('rejects scientific notation', () => {
    expect(validateProductQuantity('1e-3', '库存')).toBe('库存不能使用科学计数法')
  })

  it('enforces positive rule for min order quantity', () => {
    expect(validateProductQuantity('0.001', '起订量', { positive: true })).toBeNull()
    expect(validateProductQuantity('0', '起订量', { positive: true })).toBe('起订量必须大于 0')
    expect(validateProductQuantity('0.000', '起订量', { positive: true })).toBe('起订量必须大于 0')
  })

  it('rejects values above the database quantity limit', () => {
    expect(validateProductQuantity('999999999.999', '库存')).toBeNull()
    expect(validateProductQuantity('1000000000', '库存')).toBe('库存超过商品数量上限')
  })
})

describe('validateProductQuantities', () => {
  const base = { stock: '0', minStock: '0', minOrderQty: '1', stepQty: '1' }

  it('returns null for valid defaults', () => {
    expect(validateProductQuantities(base)).toBeNull()
  })

  it('rejects the first invalid field', () => {
    expect(validateProductQuantities({ ...base, stock: '-1' })).toContain('库存')
    expect(validateProductQuantities({ ...base, minStock: '1.2345' })).toContain('安全库存')
    expect(validateProductQuantities({ ...base, minOrderQty: '0' })).toContain('起订量')
    expect(validateProductQuantities({ ...base, stepQty: '0' })).toContain('下单增量')
    expect(validateProductQuantities({ ...base, stepQty: 'abc' })).toContain('下单增量')
  })

  it('accepts 0.001 across all non-positive fields', () => {
    expect(
      validateProductQuantities({
        stock: '0.001',
        minStock: '0.001',
        minOrderQty: '0.001',
        stepQty: '0.001',
      }),
    ).toBeNull()
  })

  it('does not block editing because of read-only legacy stock values', () => {
    expect(
      validateProductQuantities(
        { ...base, stock: '-1', minStock: '-2' },
        { editableOnly: true },
      ),
    ).toBeNull()
    expect(
      validateProductQuantities(
        { ...base, stock: '-1', minOrderQty: '0' },
        { editableOnly: true },
      ),
    ).toContain('起订量')
  })
})

describe('formatProductQuantity', () => {
  it('preserves valid string values as returned by server', () => {
    expect(formatProductQuantity('1.200')).toBe('1.200')
    expect(formatProductQuantity('0.001')).toBe('0.001')
    expect(formatProductQuantity('42')).toBe('42')
  })

  it('formats numbers up to three decimals', () => {
    expect(formatProductQuantity(1.2)).toBe('1.2')
    expect(formatProductQuantity(0.001)).toBe('0.001')
    expect(formatProductQuantity(1234.567)).toBe('1,234.567')
  })

  it('returns placeholder for null/undefined/empty', () => {
    expect(formatProductQuantity(null)).toBe('—')
    expect(formatProductQuantity(undefined)).toBe('—')
    expect(formatProductQuantity('')).toBe('—')
  })
})

describe('buildCreateBody with quantities', () => {
  it('includes parsed quantity fields when provided', () => {
    const body = buildCreateBody({
      name: '白菜', code: '', category: '', unit: 'kg', price: '3',
      spec: '', shelfDays: '7', stock: '1.234', minStock: '0.500',
      minOrderQty: '0.001', stepQty: '0.010',
    })
    expect(body.stock).toBe(1.234)
    expect(body.minStock).toBe(0.5)
    expect(body.minOrderQty).toBe(0.001)
    expect(body.stepQty).toBe(0.01)
  })

  it('omits quantity fields when not provided', () => {
    const body = buildCreateBody({
      name: '盐', code: '', category: '', unit: '', price: '3', spec: '', shelfDays: '',
    })
    expect(body).not.toHaveProperty('stock')
    expect(body).not.toHaveProperty('minStock')
    expect(body).not.toHaveProperty('minOrderQty')
    expect(body).not.toHaveProperty('stepQty')
  })
})

describe('buildEditBody with quantities', () => {
  it('only includes changed editable quantity fields', () => {
    const form = {
      name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: '7',
      stock: '10', minStock: '2', minOrderQty: '1', stepQty: '1',
    }
    const original = {
      name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: 7,
      stock: 5, minStock: 2, minOrderQty: 0.5, stepQty: 1,
    }
    const body = buildEditBody(form, original)
    expect(body).toEqual({ minOrderQty: 1 })
  })

  it('never sends physical or safety stock through the product edit endpoint', () => {
    const form = {
      name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: '7',
      stock: '0', minStock: '0', minOrderQty: '1', stepQty: '1',
    }
    const original = {
      name: '白菜', code: 'v1', category: '蔬菜', unit: 'kg', spec: '', shelfDays: 7,
      stock: 1, minStock: 0, minOrderQty: 1, stepQty: 1,
    }
    const body = buildEditBody(form, original)
    expect(body).toEqual({})
  })
})
