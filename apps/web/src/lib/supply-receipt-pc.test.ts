import { describe, expect, it } from 'vitest'
import {
  buildReceiptQuery,
  DEFAULT_RECEIPT_FILTERS,
  formatReceiptMoney,
  formatReceiptStatusLabel,
  hasActiveReceiptFilters,
  keepReceiptFiltersForPage,
  projectReceiptRow,
  receiptDateText,
  receiptItemSummary,
  receiptPaginationRange,
  receiptStatusTone,
  receiptTotalPages,
  resetReceiptFilterPage,
  validateReceiptDateRange,
  type ReceiptFilters,
} from './supply-receipt-pc'

describe('buildReceiptQuery', () => {
  it('encodes default filters with page and pageSize only', () => {
    const query = buildReceiptQuery(DEFAULT_RECEIPT_FILTERS)
    expect(query).toBe('?page=1&pageSize=20')
  })

  it('trims keyword and skips empty values', () => {
    const query = buildReceiptQuery({ ...DEFAULT_RECEIPT_FILTERS, keyword: '  白菜  ' })
    expect(query).toContain('keyword=%E7%99%BD%E8%8F%9C')
    expect(query).not.toContain('storeId')
    expect(query).not.toContain('dateFrom')
    expect(query).not.toContain('dateTo')
  })

  it('encodes all filter fields', () => {
    const query = buildReceiptQuery({
      keyword: 'RK2026',
      storeId: 'store-1',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-25',
      page: 3,
      pageSize: 50,
    })
    expect(query).toContain('keyword=RK2026')
    expect(query).toContain('storeId=store-1')
    expect(query).toContain('dateFrom=2026-07-01')
    expect(query).toContain('dateTo=2026-07-25')
    expect(query).not.toContain('startDate')
    expect(query).not.toContain('endDate')
    expect(query).toContain('page=3')
    expect(query).toContain('pageSize=50')
  })

  it('falls back to default pageSize for invalid values', () => {
    const query = buildReceiptQuery({ ...DEFAULT_RECEIPT_FILTERS, pageSize: 999 })
    expect(query).toContain('pageSize=20')
  })

  it('clamps page to at least 1', () => {
    const query = buildReceiptQuery({ ...DEFAULT_RECEIPT_FILTERS, page: 0 })
    expect(query).toContain('page=1')
  })
})

describe('resetReceiptFilterPage', () => {
  it('resets page to 1 when filter changes', () => {
    const current: ReceiptFilters = { ...DEFAULT_RECEIPT_FILTERS, page: 5 }
    const next = resetReceiptFilterPage(current, { keyword: 'test' })
    expect(next.page).toBe(1)
    expect(next.keyword).toBe('test')
    expect(next.storeId).toBe('')
  })

  it('preserves other filters when resetting page', () => {
    const current: ReceiptFilters = {
      ...DEFAULT_RECEIPT_FILTERS,
      storeId: 'store-1',
      dateFrom: '2026-07-01',
      page: 3,
    }
    const next = resetReceiptFilterPage(current, { dateTo: '2026-07-25' })
    expect(next.page).toBe(1)
    expect(next.storeId).toBe('store-1')
    expect(next.dateFrom).toBe('2026-07-01')
    expect(next.dateTo).toBe('2026-07-25')
  })
})

describe('keepReceiptFiltersForPage', () => {
  it('keeps all filters and only updates page', () => {
    const current: ReceiptFilters = {
      keyword: '松茸',
      storeId: 'store-1',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-25',
      page: 1,
      pageSize: 50,
    }
    const next = keepReceiptFiltersForPage(current, 4)
    expect(next.page).toBe(4)
    expect(next.keyword).toBe('松茸')
    expect(next.storeId).toBe('store-1')
    expect(next.dateFrom).toBe('2026-07-01')
    expect(next.dateTo).toBe('2026-07-25')
    expect(next.pageSize).toBe(50)
  })

  it('clamps page to at least 1', () => {
    const next = keepReceiptFiltersForPage(DEFAULT_RECEIPT_FILTERS, -1)
    expect(next.page).toBe(1)
  })
})

describe('validateReceiptDateRange', () => {
  it('returns null when both dates are empty', () => {
    expect(validateReceiptDateRange('', '')).toBeNull()
  })

  it('returns null when only one date is set', () => {
    expect(validateReceiptDateRange('2026-07-01', '')).toBeNull()
    expect(validateReceiptDateRange('', '2026-07-25')).toBeNull()
  })

  it('returns null for valid range', () => {
    expect(validateReceiptDateRange('2026-07-01', '2026-07-25')).toBeNull()
  })

  it('returns null for same-day range', () => {
    expect(validateReceiptDateRange('2026-07-15', '2026-07-15')).toBeNull()
  })

  it('returns error when dateFrom is after dateTo', () => {
    const result = validateReceiptDateRange('2026-07-25', '2026-07-01')
    expect(result).toBe('开始日期不能晚于结束日期')
  })
})

describe('hasActiveReceiptFilters', () => {
  it('returns false for default filters', () => {
    expect(hasActiveReceiptFilters(DEFAULT_RECEIPT_FILTERS)).toBe(false)
  })

  it('returns true when keyword is set (ignoring page)', () => {
    expect(hasActiveReceiptFilters({ ...DEFAULT_RECEIPT_FILTERS, keyword: 'test' })).toBe(true)
  })

  it('returns true when storeId is set', () => {
    expect(hasActiveReceiptFilters({ ...DEFAULT_RECEIPT_FILTERS, storeId: 'store-1' })).toBe(true)
  })

  it('returns true when dates are set', () => {
    expect(hasActiveReceiptFilters({ ...DEFAULT_RECEIPT_FILTERS, dateFrom: '2026-07-01' })).toBe(true)
    expect(hasActiveReceiptFilters({ ...DEFAULT_RECEIPT_FILTERS, dateTo: '2026-07-25' })).toBe(true)
  })

  it('ignores whitespace-only keyword', () => {
    expect(hasActiveReceiptFilters({ ...DEFAULT_RECEIPT_FILTERS, keyword: '   ' })).toBe(false)
  })
})

describe('receiptPaginationRange', () => {
  it('returns correct range for first page', () => {
    expect(receiptPaginationRange(1, 20, 100)).toEqual({ start: 1, end: 20 })
  })

  it('clamps end to total on last page', () => {
    expect(receiptPaginationRange(5, 20, 95)).toEqual({ start: 81, end: 95 })
  })

  it('returns zeros when total is 0', () => {
    expect(receiptPaginationRange(1, 20, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('receiptTotalPages', () => {
  it('returns 1 for zero total', () => {
    expect(receiptTotalPages(0, 20)).toBe(1)
  })

  it('calculates correctly', () => {
    expect(receiptTotalPages(100, 20)).toBe(5)
    expect(receiptTotalPages(95, 20)).toBe(5)
    expect(receiptTotalPages(1, 20)).toBe(1)
  })
})

describe('projectReceiptRow', () => {
  const fullRow = {
    id: 'r1',
    no: 'RK20260701001',
    storeId: 's1',
    status: 'CONFIRMED',
    deliveryDate: '2026-07-01T00:00:00.000Z',
    note: 'test',
    createdAt: '2026-07-01T10:00:00.000Z',
    totalAmount: 1000,
    store: { id: 's1', no: 'S01', name: '门店A' },
    supplier: { id: 'sup1', no: 'SUP01', name: '供应商A' },
    items: [
      { productNameSnapshot: '白菜', productCodeSnapshot: 'BC01', productSpecSnapshot: '500g' },
    ],
    paymentSchedule: { id: 'ps1', status: 'PENDING' },
    invoice: { id: 'inv1' },
    bankInfo: { account: '123456' },
  }

  it('projects only read-only fields', () => {
    const projected = projectReceiptRow(fullRow)
    expect(projected.id).toBe('r1')
    expect(projected.no).toBe('RK20260701001')
    expect(projected.status).toBe('CONFIRMED')
    expect(projected.store).toEqual({ id: 's1', name: '门店A', no: 'S01' })
    expect(projected.supplier).toEqual({ id: 'sup1', name: '供应商A', no: 'SUP01' })
    expect(projected.items).toHaveLength(1)
    expect(projected.items[0].productNameSnapshot).toBe('白菜')
  })

  it('excludes financial fields from projection', () => {
    const projected = projectReceiptRow(fullRow)
    expect((projected as any).paymentSchedule).toBeUndefined()
    expect((projected as any).invoice).toBeUndefined()
    expect((projected as any).bankInfo).toBeUndefined()
    expect((projected as any).totalAmount).toBeUndefined()
  })

  it('handles null store and supplier', () => {
    const row = { ...fullRow, store: null, supplier: null, items: [] }
    const projected = projectReceiptRow(row)
    expect(projected.store).toBeNull()
    expect(projected.supplier).toBeNull()
    expect(projected.items).toEqual([])
  })

  it('falls back to product relation when snapshot is missing', () => {
    const row = {
      ...fullRow,
      items: [{ product: { name: '萝卜', code: 'LB01', spec: '1kg' } }],
    }
    const projected = projectReceiptRow(row)
    expect(projected.items[0].productNameSnapshot).toBe('萝卜')
    expect(projected.items[0].productCodeSnapshot).toBe('LB01')
  })
})

describe('receiptItemSummary', () => {
  it('returns dash for empty items', () => {
    expect(receiptItemSummary([])).toBe('—')
  })

  it('joins item names', () => {
    const items = [
      { productNameSnapshot: '白菜' },
      { productNameSnapshot: '萝卜' },
    ]
    expect(receiptItemSummary(items)).toBe('白菜、萝卜')
  })

  it('truncates with count when exceeding max', () => {
    const items = [
      { productNameSnapshot: '白菜' },
      { productNameSnapshot: '萝卜' },
      { productNameSnapshot: '土豆' },
      { productNameSnapshot: '番茄' },
    ]
    expect(receiptItemSummary(items, 3)).toBe('白菜、萝卜、土豆 等4项')
  })

  it('skips null names', () => {
    const items = [
      { productNameSnapshot: null },
      { productNameSnapshot: '白菜' },
    ]
    expect(receiptItemSummary(items)).toBe('白菜')
  })
})

describe('formatReceiptStatusLabel', () => {
  it('maps known statuses', () => {
    expect(formatReceiptStatusLabel('CONFIRMED')).toBe('已确认')
    expect(formatReceiptStatusLabel('DRAFT')).toBe('草稿')
    expect(formatReceiptStatusLabel('VOID')).toBe('已作废')
  })

  it('returns raw status for unknown values', () => {
    expect(formatReceiptStatusLabel('UNKNOWN')).toBe('UNKNOWN')
  })
})

describe('receiptStatusTone', () => {
  it('returns green for confirmed/accounted', () => {
    expect(receiptStatusTone('CONFIRMED')).toBe('green')
    expect(receiptStatusTone('ACCOUNTED')).toBe('green')
  })

  it('returns red for void/rejected', () => {
    expect(receiptStatusTone('VOID')).toBe('red')
    expect(receiptStatusTone('REJECTED')).toBe('red')
  })

  it('returns orange for pending states', () => {
    expect(receiptStatusTone('PENDING')).toBe('orange')
    expect(receiptStatusTone('PENDING_CONFIRM')).toBe('orange')
  })

  it('returns gray for draft', () => {
    expect(receiptStatusTone('DRAFT')).toBe('gray')
  })
})

describe('formatReceiptMoney', () => {
  it('formats numbers', () => {
    expect(formatReceiptMoney(1234.5)).toBe('¥1,234.50')
  })

  it('handles null/undefined', () => {
    expect(formatReceiptMoney(null)).toBe('—')
    expect(formatReceiptMoney(undefined)).toBe('—')
  })
})

describe('receiptDateText', () => {
  it('extracts date portion', () => {
    expect(receiptDateText('2026-07-01T00:00:00.000Z')).toBe('2026-07-01')
  })

  it('returns dash for null/undefined', () => {
    expect(receiptDateText(null)).toBe('—')
    expect(receiptDateText(undefined)).toBe('—')
  })
})
