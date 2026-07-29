import { describe, expect, it } from 'vitest'
import { filterSupplierCategories, isStoreOnlyCategory } from './supplier-category-filter'

describe('isStoreOnlyCategory', () => {
  it('identifies station categories ending with 岗', () => {
    expect(isStoreOnlyCategory('素菜岗')).toBe(true)
    expect(isStoreOnlyCategory('菌菇岗')).toBe(true)
    expect(isStoreOnlyCategory('配锅岗')).toBe(true)
    expect(isStoreOnlyCategory('切配岗')).toBe(true)
  })

  it('identifies known store-only names', () => {
    expect(isStoreOnlyCategory('前厅调料')).toBe(true)
    expect(isStoreOnlyCategory('水吧')).toBe(true)
    expect(isStoreOnlyCategory('BOM待采购映射')).toBe(true)
  })

  it('trims whitespace before matching', () => {
    expect(isStoreOnlyCategory(' 素菜岗 ')).toBe(true)
    expect(isStoreOnlyCategory('  水吧  ')).toBe(true)
  })

  it('keeps normal supplier categories', () => {
    expect(isStoreOnlyCategory('常见菌类')).toBe(false)
    expect(isStoreOnlyCategory('干货类')).toBe(false)
    expect(isStoreOnlyCategory('牛肉类')).toBe(false)
    expect(isStoreOnlyCategory('蔬菜类')).toBe(false)
    expect(isStoreOnlyCategory('酒水类')).toBe(false)
    expect(isStoreOnlyCategory('餐具类')).toBe(false)
    expect(isStoreOnlyCategory('其他')).toBe(false)
  })

  it('returns false for empty or blank names', () => {
    expect(isStoreOnlyCategory('')).toBe(false)
    expect(isStoreOnlyCategory('   ')).toBe(false)
  })
})

describe('filterSupplierCategories', () => {
  it('removes store-only categories and keeps supplier ones', () => {
    const input = [
      { name: '蔬菜类', count: 10 },
      { name: '素菜岗', count: 3 },
      { name: '牛肉类', count: 5 },
      { name: '水吧', count: 2 },
      { name: 'BOM待采购映射', count: 8 },
      { name: '干货类', count: 7 },
    ]
    const result = filterSupplierCategories(input)
    expect(result.map(c => c.name)).toEqual(['蔬菜类', '牛肉类', '干货类'])
  })

  it('returns empty array when all categories are store-only', () => {
    const input = [
      { name: '菌菇岗', count: 1 },
      { name: '前厅调料', count: 2 },
    ]
    expect(filterSupplierCategories(input)).toEqual([])
  })

  it('returns all categories when none are store-only', () => {
    const input = [
      { name: '蔬菜类', count: 10 },
      { name: '酒水类', count: 4 },
    ]
    expect(filterSupplierCategories(input)).toEqual(input)
  })

  it('preserves extra fields on category objects', () => {
    const input = [
      { id: '1', name: '蔬菜类', count: 10, sortOrder: 0, isActive: true, isSystem: false },
      { id: '2', name: '配锅岗', count: 3, sortOrder: 1, isActive: true, isSystem: false },
    ]
    const result = filterSupplierCategories(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(input[0])
  })

  it('handles empty input', () => {
    expect(filterSupplierCategories([])).toEqual([])
  })
})
