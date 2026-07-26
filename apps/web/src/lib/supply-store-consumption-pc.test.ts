import { describe, expect, it } from 'vitest'
import {
  buildConsumptionQuery,
  consumptionPaginationRange,
  consumptionTotalPages,
  DEFAULT_CONSUMPTION_FILTERS,
  hasActiveConsumptionFilters,
  isValidConsumptionPage,
  keepConsumptionFiltersForPage,
  resetConsumptionFilterPage,
  validateConsumptionDateRange,
  type ConsumptionFilters,
} from './supply-store-consumption-pc'

describe('buildConsumptionQuery', () => {
  it('encodes default filters with storeId, page and pageSize', () => {
    const query = buildConsumptionQuery({ ...DEFAULT_CONSUMPTION_FILTERS, storeId: 'store-1' })
    expect(query).toContain('storeId=store-1')
    expect(query).toContain('page=1')
    expect(query).toContain('pageSize=20')
    expect(query).not.toContain('q=')
    expect(query).not.toContain('startDate=')
    expect(query).not.toContain('endDate=')
  })

  it('trims q and skips empty values', () => {
    const query = buildConsumptionQuery({
      ...DEFAULT_CONSUMPTION_FILTERS,
      storeId: 'store-1',
      q: '  土豆  ',
    })
    expect(query).toContain('q=%E5%9C%9F%E8%B1%86')
    expect(query).not.toContain('q=  ')
    expect(query).toContain('storeId=store-1')
  })

  it('encodes all filter fields', () => {
    const query = buildConsumptionQuery({
      storeId: 'store-1',
      q: 'SKU-001',
      startDate: '2026-07-01',
      endDate: '2026-07-25',
      page: 3,
      pageSize: 50,
    })
    expect(query).toContain('storeId=store-1')
    expect(query).toContain('q=SKU-001')
    expect(query).toContain('startDate=2026-07-01')
    expect(query).toContain('endDate=2026-07-25')
    expect(query).toContain('page=3')
    expect(query).toContain('pageSize=50')
  })

  it('falls back to default pageSize for invalid values', () => {
    const query = buildConsumptionQuery({
      ...DEFAULT_CONSUMPTION_FILTERS,
      storeId: 'store-1',
      pageSize: 999 as any,
    })
    expect(query).toContain('pageSize=20')
  })

  it('clamps page to at least 1', () => {
    const query = buildConsumptionQuery({
      ...DEFAULT_CONSUMPTION_FILTERS,
      storeId: 'store-1',
      page: 0,
    })
    expect(query).toContain('page=1')
  })

  it('skips storeId when empty', () => {
    const query = buildConsumptionQuery(DEFAULT_CONSUMPTION_FILTERS)
    expect(query).not.toContain('storeId=')
    expect(query).toContain('page=1')
    expect(query).toContain('pageSize=20')
  })
})

describe('resetConsumptionFilterPage', () => {
  it('resets page to 1 when filter changes', () => {
    const current: ConsumptionFilters = { ...DEFAULT_CONSUMPTION_FILTERS, storeId: 'store-1', page: 5 }
    const next = resetConsumptionFilterPage(current, { q: 'test' })
    expect(next.page).toBe(1)
    expect(next.q).toBe('test')
    expect(next.storeId).toBe('store-1')
  })

  it('preserves other filters when resetting page', () => {
    const current: ConsumptionFilters = {
      ...DEFAULT_CONSUMPTION_FILTERS,
      storeId: 'store-1',
      startDate: '2026-07-01',
      page: 3,
      pageSize: 50,
    }
    const next = resetConsumptionFilterPage(current, { endDate: '2026-07-25' })
    expect(next.page).toBe(1)
    expect(next.storeId).toBe('store-1')
    expect(next.startDate).toBe('2026-07-01')
    expect(next.endDate).toBe('2026-07-25')
    expect(next.pageSize).toBe(50)
  })

  it('resets page to 1 when store changes', () => {
    const current: ConsumptionFilters = { ...DEFAULT_CONSUMPTION_FILTERS, storeId: 'store-1', page: 4 }
    const next = resetConsumptionFilterPage(current, { storeId: 'store-2' })
    expect(next.page).toBe(1)
    expect(next.storeId).toBe('store-2')
  })
})

describe('keepConsumptionFiltersForPage', () => {
  it('keeps all filters and only updates page', () => {
    const current: ConsumptionFilters = {
      storeId: 'store-1',
      q: '土豆',
      startDate: '2026-07-01',
      endDate: '2026-07-25',
      page: 1,
      pageSize: 50,
    }
    const next = keepConsumptionFiltersForPage(current, 4)
    expect(next.page).toBe(4)
    expect(next.q).toBe('土豆')
    expect(next.storeId).toBe('store-1')
    expect(next.startDate).toBe('2026-07-01')
    expect(next.endDate).toBe('2026-07-25')
    expect(next.pageSize).toBe(50)
  })

  it('clamps page to at least 1', () => {
    const next = keepConsumptionFiltersForPage(DEFAULT_CONSUMPTION_FILTERS, -1)
    expect(next.page).toBe(1)
  })
})

describe('validateConsumptionDateRange', () => {
  it('returns null when both dates are empty', () => {
    expect(validateConsumptionDateRange('', '')).toBeNull()
  })

  it('returns null when only one date is set', () => {
    expect(validateConsumptionDateRange('2026-07-01', '')).toBeNull()
    expect(validateConsumptionDateRange('', '2026-07-25')).toBeNull()
  })

  it('returns null for valid range', () => {
    expect(validateConsumptionDateRange('2026-07-01', '2026-07-25')).toBeNull()
  })

  it('returns null for same-day range', () => {
    expect(validateConsumptionDateRange('2026-07-15', '2026-07-15')).toBeNull()
  })

  it('returns error when startDate is after endDate', () => {
    expect(validateConsumptionDateRange('2026-07-25', '2026-07-01')).toBe('开始日期不能晚于结束日期')
  })
})

describe('hasActiveConsumptionFilters', () => {
  it('returns false for default filters', () => {
    expect(hasActiveConsumptionFilters(DEFAULT_CONSUMPTION_FILTERS)).toBe(false)
  })

  it('returns true when q is set', () => {
    expect(hasActiveConsumptionFilters({ ...DEFAULT_CONSUMPTION_FILTERS, q: 'test' })).toBe(true)
  })

  it('returns true when dates are set', () => {
    expect(hasActiveConsumptionFilters({ ...DEFAULT_CONSUMPTION_FILTERS, startDate: '2026-07-01' })).toBe(true)
    expect(hasActiveConsumptionFilters({ ...DEFAULT_CONSUMPTION_FILTERS, endDate: '2026-07-25' })).toBe(true)
  })

  it('ignores whitespace-only q', () => {
    expect(hasActiveConsumptionFilters({ ...DEFAULT_CONSUMPTION_FILTERS, q: '   ' })).toBe(false)
  })
})

describe('consumptionPaginationRange', () => {
  it('returns correct range for first page', () => {
    expect(consumptionPaginationRange(1, 20, 100)).toEqual({ start: 1, end: 20 })
  })

  it('clamps end to total on last page', () => {
    expect(consumptionPaginationRange(5, 20, 95)).toEqual({ start: 81, end: 95 })
  })

  it('returns zeros when total is 0', () => {
    expect(consumptionPaginationRange(1, 20, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('consumptionTotalPages', () => {
  it('returns 1 for zero total', () => {
    expect(consumptionTotalPages(0, 20)).toBe(1)
  })

  it('calculates correctly', () => {
    expect(consumptionTotalPages(100, 20)).toBe(5)
    expect(consumptionTotalPages(95, 20)).toBe(5)
    expect(consumptionTotalPages(1, 20)).toBe(1)
  })
})

describe('isValidConsumptionPage', () => {
  it('returns false for page below 1', () => {
    expect(isValidConsumptionPage(0, 100, 20)).toBe(false)
  })

  it('returns false when total is 0', () => {
    expect(isValidConsumptionPage(1, 0, 20)).toBe(false)
  })

  it('returns false when page exceeds total pages', () => {
    expect(isValidConsumptionPage(6, 100, 20)).toBe(false)
  })

  it('returns true for valid page', () => {
    expect(isValidConsumptionPage(5, 100, 20)).toBe(true)
  })
})
