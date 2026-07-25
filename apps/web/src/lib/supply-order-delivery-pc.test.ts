import { describe, expect, it } from 'vitest'
import {
  buildDeliveryQuery,
  buildOrderQuery,
  DEFAULT_DELIVERY_FILTERS,
  DEFAULT_ORDER_FILTERS,
  deliveryItemSummary,
  deliveryStatusTone,
  formatDeliveryStatusLabel,
  formatOrderStatusLabel,
  hasActiveDeliveryFilters,
  hasActiveOrderFilters,
  isDeliveryStatus,
  isOrderStatus,
  keepDeliveryFiltersForPage,
  keepOrderFiltersForPage,
  orderDeliveryDateText,
  orderDeliveryPaginationRange,
  orderDeliveryTotalPages,
  orderItemSummary,
  orderStatusTone,
  projectDeliveryRow,
  projectOrderRow,
  resetDeliveryFilterPage,
  resetOrderFilterPage,
  validateOrderDeliveryDateRange,
  type DeliveryFilters,
  type OrderFilters,
} from './supply-order-delivery-pc'

describe('buildOrderQuery', () => {
  it('encodes default filters with page and pageSize only', () => {
    const query = buildOrderQuery(DEFAULT_ORDER_FILTERS)
    expect(query).toBe('?page=1&pageSize=20')
  })

  it('trims keyword and skips empty values', () => {
    const query = buildOrderQuery({ ...DEFAULT_ORDER_FILTERS, keyword: '  白菜  ' })
    expect(query).toContain('keyword=%E7%99%BD%E8%8F%9C')
    expect(query).not.toContain('storeId')
    expect(query).not.toContain('status')
    expect(query).not.toContain('dateFrom')
    expect(query).not.toContain('dateTo')
  })

  it('encodes all filter fields using dateFrom/dateTo', () => {
    const query = buildOrderQuery({
      keyword: 'PO2026',
      storeId: 'store-1',
      status: 'SUBMITTED',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-25',
      page: 3,
      pageSize: 50,
    })
    expect(query).toContain('keyword=PO2026')
    expect(query).toContain('storeId=store-1')
    expect(query).toContain('status=SUBMITTED')
    expect(query).toContain('dateFrom=2026-07-01')
    expect(query).toContain('dateTo=2026-07-25')
    expect(query).not.toContain('startDate')
    expect(query).not.toContain('endDate')
    expect(query).toContain('page=3')
    expect(query).toContain('pageSize=50')
  })

  it('falls back to default pageSize for invalid values', () => {
    const query = buildOrderQuery({ ...DEFAULT_ORDER_FILTERS, pageSize: 999 })
    expect(query).toContain('pageSize=20')
  })

  it('clamps page to at least 1', () => {
    const query = buildOrderQuery({ ...DEFAULT_ORDER_FILTERS, page: 0 })
    expect(query).toContain('page=1')
  })

  it('ignores invalid status values', () => {
    const query = buildOrderQuery({ ...DEFAULT_ORDER_FILTERS, status: 'NOT_REAL' as any })
    expect(query).not.toContain('status')
  })
})

describe('buildDeliveryQuery', () => {
  it('encodes default filters with page and pageSize only', () => {
    const query = buildDeliveryQuery(DEFAULT_DELIVERY_FILTERS)
    expect(query).toBe('?page=1&pageSize=20')
  })

  it('trims keyword and skips empty values', () => {
    const query = buildDeliveryQuery({ ...DEFAULT_DELIVERY_FILTERS, keyword: '  配送  ' })
    expect(query).toContain('keyword=')
    expect(query).not.toContain('storeId')
    expect(query).not.toContain('status')
  })

  it('encodes all filter fields using dateFrom/dateTo', () => {
    const query = buildDeliveryQuery({
      keyword: 'PS2026',
      storeId: 'store-2',
      status: 'SHIPPED',
      dateFrom: '2026-07-05',
      dateTo: '2026-07-20',
      page: 2,
      pageSize: 10,
    })
    expect(query).toContain('keyword=PS2026')
    expect(query).toContain('storeId=store-2')
    expect(query).toContain('status=SHIPPED')
    expect(query).toContain('dateFrom=2026-07-05')
    expect(query).toContain('dateTo=2026-07-20')
    expect(query).toContain('page=2')
    expect(query).toContain('pageSize=10')
  })

  it('ignores invalid status values', () => {
    const query = buildDeliveryQuery({ ...DEFAULT_DELIVERY_FILTERS, status: 'PENDING' as any })
    expect(query).not.toContain('status')
  })
})

describe('resetOrderFilterPage', () => {
  it('resets page to 1 when filter changes', () => {
    const current: OrderFilters = { ...DEFAULT_ORDER_FILTERS, page: 5 }
    const next = resetOrderFilterPage(current, { keyword: 'test' })
    expect(next.page).toBe(1)
    expect(next.keyword).toBe('test')
    expect(next.storeId).toBe('')
  })

  it('preserves other filters when resetting page', () => {
    const current: OrderFilters = {
      ...DEFAULT_ORDER_FILTERS,
      storeId: 'store-1',
      status: 'CONFIRMED',
      dateFrom: '2026-07-01',
      page: 3,
    }
    const next = resetOrderFilterPage(current, { dateTo: '2026-07-25' })
    expect(next.page).toBe(1)
    expect(next.storeId).toBe('store-1')
    expect(next.status).toBe('CONFIRMED')
    expect(next.dateFrom).toBe('2026-07-01')
    expect(next.dateTo).toBe('2026-07-25')
  })
})

describe('resetDeliveryFilterPage', () => {
  it('resets page to 1 when filter changes', () => {
    const current: DeliveryFilters = { ...DEFAULT_DELIVERY_FILTERS, page: 4 }
    const next = resetDeliveryFilterPage(current, { storeId: 'store-2' })
    expect(next.page).toBe(1)
    expect(next.storeId).toBe('store-2')
  })
})

describe('keepOrderFiltersForPage', () => {
  it('keeps all filters and only updates page', () => {
    const current: OrderFilters = {
      keyword: '松茸',
      storeId: 'store-1',
      status: 'SUBMITTED',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-25',
      page: 1,
      pageSize: 50,
    }
    const next = keepOrderFiltersForPage(current, 4)
    expect(next.page).toBe(4)
    expect(next.keyword).toBe('松茸')
    expect(next.storeId).toBe('store-1')
    expect(next.status).toBe('SUBMITTED')
    expect(next.dateFrom).toBe('2026-07-01')
    expect(next.dateTo).toBe('2026-07-25')
    expect(next.pageSize).toBe(50)
  })

  it('clamps page to at least 1', () => {
    const next = keepOrderFiltersForPage(DEFAULT_ORDER_FILTERS, -1)
    expect(next.page).toBe(1)
  })
})

describe('keepDeliveryFiltersForPage', () => {
  it('keeps all filters and only updates page', () => {
    const current: DeliveryFilters = {
      ...DEFAULT_DELIVERY_FILTERS,
      keyword: 'PS',
      status: 'SHIPPED',
      pageSize: 10,
    }
    const next = keepDeliveryFiltersForPage(current, 3)
    expect(next.page).toBe(3)
    expect(next.keyword).toBe('PS')
    expect(next.status).toBe('SHIPPED')
    expect(next.pageSize).toBe(10)
  })
})

describe('validateOrderDeliveryDateRange', () => {
  it('returns null when both dates are empty', () => {
    expect(validateOrderDeliveryDateRange('', '')).toBeNull()
  })

  it('returns null when only one date is set', () => {
    expect(validateOrderDeliveryDateRange('2026-07-01', '')).toBeNull()
    expect(validateOrderDeliveryDateRange('', '2026-07-25')).toBeNull()
  })

  it('returns null for valid range', () => {
    expect(validateOrderDeliveryDateRange('2026-07-01', '2026-07-25')).toBeNull()
  })

  it('returns null for same-day range', () => {
    expect(validateOrderDeliveryDateRange('2026-07-15', '2026-07-15')).toBeNull()
  })

  it('returns error when dateFrom is after dateTo', () => {
    const result = validateOrderDeliveryDateRange('2026-07-25', '2026-07-01')
    expect(result).toBe('开始日期不能晚于结束日期')
  })
})

describe('hasActiveOrderFilters', () => {
  it('returns false for default filters', () => {
    expect(hasActiveOrderFilters(DEFAULT_ORDER_FILTERS)).toBe(false)
  })

  it('returns true when keyword is set (ignoring page)', () => {
    expect(hasActiveOrderFilters({ ...DEFAULT_ORDER_FILTERS, keyword: 'test' })).toBe(true)
  })

  it('returns true when storeId is set', () => {
    expect(hasActiveOrderFilters({ ...DEFAULT_ORDER_FILTERS, storeId: 'store-1' })).toBe(true)
  })

  it('returns true when status is set', () => {
    expect(hasActiveOrderFilters({ ...DEFAULT_ORDER_FILTERS, status: 'SUBMITTED' })).toBe(true)
  })

  it('returns true when dates are set', () => {
    expect(hasActiveOrderFilters({ ...DEFAULT_ORDER_FILTERS, dateFrom: '2026-07-01' })).toBe(true)
  })

  it('ignores whitespace-only keyword', () => {
    expect(hasActiveOrderFilters({ ...DEFAULT_ORDER_FILTERS, keyword: '   ' })).toBe(false)
  })
})

describe('hasActiveDeliveryFilters', () => {
  it('returns false for default filters', () => {
    expect(hasActiveDeliveryFilters(DEFAULT_DELIVERY_FILTERS)).toBe(false)
  })

  it('returns true when status is set', () => {
    expect(hasActiveDeliveryFilters({ ...DEFAULT_DELIVERY_FILTERS, status: 'SHIPPED' })).toBe(true)
  })
})

describe('isOrderStatus', () => {
  it('returns true for valid order statuses', () => {
    expect(isOrderStatus('SUBMITTED')).toBe(true)
    expect(isOrderStatus('COMPLETED')).toBe(true)
  })

  it('returns false for delivery-only statuses', () => {
    expect(isOrderStatus('SHIPPED')).toBe(false)
    expect(isOrderStatus('DELIVERED')).toBe(false)
  })
})

describe('isDeliveryStatus', () => {
  it('returns true for valid delivery statuses', () => {
    expect(isDeliveryStatus('SHIPPED')).toBe(true)
    expect(isDeliveryStatus('DELIVERED')).toBe(true)
  })

  it('returns false for order-only statuses', () => {
    expect(isDeliveryStatus('SUBMITTED')).toBe(false)
    expect(isDeliveryStatus('PENDING_CONFIRM')).toBe(false)
  })
})

describe('orderDeliveryPaginationRange', () => {
  it('returns correct range for first page', () => {
    expect(orderDeliveryPaginationRange(1, 20, 100)).toEqual({ start: 1, end: 20 })
  })

  it('clamps end to total on last page', () => {
    expect(orderDeliveryPaginationRange(5, 20, 95)).toEqual({ start: 81, end: 95 })
  })

  it('returns zeros when total is 0', () => {
    expect(orderDeliveryPaginationRange(1, 20, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('orderDeliveryTotalPages', () => {
  it('returns 1 for zero total', () => {
    expect(orderDeliveryTotalPages(0, 20)).toBe(1)
  })

  it('calculates correctly', () => {
    expect(orderDeliveryTotalPages(100, 20)).toBe(5)
    expect(orderDeliveryTotalPages(95, 20)).toBe(5)
    expect(orderDeliveryTotalPages(1, 20)).toBe(1)
  })
})

describe('formatOrderStatusLabel', () => {
  it('maps known statuses', () => {
    expect(formatOrderStatusLabel('DRAFT')).toBe('草稿')
    expect(formatOrderStatusLabel('SUBMITTED')).toBe('已提交')
    expect(formatOrderStatusLabel('COMPLETED')).toBe('已完成')
  })

  it('returns raw status for unknown values', () => {
    expect(formatOrderStatusLabel('UNKNOWN')).toBe('UNKNOWN')
  })
})

describe('formatDeliveryStatusLabel', () => {
  it('maps known statuses', () => {
    expect(formatDeliveryStatusLabel('DRAFT')).toBe('草稿')
    expect(formatDeliveryStatusLabel('SHIPPED')).toBe('已发货')
    expect(formatDeliveryStatusLabel('RECEIVED')).toBe('已收货')
  })

  it('does not use order labels', () => {
    expect(formatDeliveryStatusLabel('SUBMITTED')).toBe('SUBMITTED')
  })
})

describe('orderStatusTone', () => {
  it('returns green for completed/confirmed', () => {
    expect(orderStatusTone('COMPLETED')).toBe('green')
    expect(orderStatusTone('CONFIRMED')).toBe('green')
  })

  it('returns red for cancelled', () => {
    expect(orderStatusTone('CANCELLED')).toBe('red')
  })

  it('returns orange for active flow statuses', () => {
    expect(orderStatusTone('SUBMITTED')).toBe('orange')
    expect(orderStatusTone('DELIVERING')).toBe('orange')
    expect(orderStatusTone('PENDING_CONFIRM')).toBe('orange')
    expect(orderStatusTone('RECEIVED')).toBe('orange')
  })

  it('returns gray for draft', () => {
    expect(orderStatusTone('DRAFT')).toBe('gray')
  })
})

describe('deliveryStatusTone', () => {
  it('returns green for received', () => {
    expect(deliveryStatusTone('RECEIVED')).toBe('green')
  })

  it('returns red for cancelled', () => {
    expect(deliveryStatusTone('CANCELLED')).toBe('red')
  })

  it('returns orange for shipped/delivered', () => {
    expect(deliveryStatusTone('SHIPPED')).toBe('orange')
    expect(deliveryStatusTone('DELIVERED')).toBe('orange')
  })

  it('returns gray for draft', () => {
    expect(deliveryStatusTone('DRAFT')).toBe('gray')
  })
})

describe('projectOrderRow', () => {
  const fullRow = {
    id: 'o1',
    no: 'PO20260701001',
    storeId: 's1',
    supplierId: 'sup1',
    status: 'SUBMITTED',
    createdAt: '2026-07-01T10:00:00.000Z',
    expectedDeliveryDate: '2026-07-02T00:00:00.000Z',
    store: { id: 's1', no: 'S01', name: '门店A' },
    supplier: { id: 'sup1', no: 'SUP01', name: '供应商A' },
    submittedSnapshot: {
      items: [
        { name: '白菜', code: 'BC01', spec: '500g' },
        { name: '萝卜', code: 'LB01', spec: '1kg' },
      ],
    },
    items: [
      { productNameSnapshot: null, product: { name: '当前白菜', code: 'BC01', spec: '500g' } },
    ],
    paymentSchedule: { id: 'ps1', status: 'PENDING' },
    invoice: { id: 'inv1' },
    bankInfo: { account: '123456' },
    originalTotalAmount: 1000,
    currentOrderAmount: 950,
  }

  it('projects only read-only fields', () => {
    const projected = projectOrderRow(fullRow)
    expect(projected.id).toBe('o1')
    expect(projected.no).toBe('PO20260701001')
    expect(projected.status).toBe('SUBMITTED')
    expect(projected.expectedDeliveryDate).toBe('2026-07-02T00:00:00.000Z')
    expect(projected.store).toEqual({ id: 's1', name: '门店A', no: 'S01' })
    expect(projected.supplier).toEqual({ id: 'sup1', name: '供应商A', no: 'SUP01' })
    expect(projected.submittedSnapshotItems).toHaveLength(2)
  })

  it('excludes financial and write-operation fields', () => {
    const projected = projectOrderRow(fullRow)
    expect((projected as any).paymentSchedule).toBeUndefined()
    expect((projected as any).invoice).toBeUndefined()
    expect((projected as any).bankInfo).toBeUndefined()
    expect((projected as any).originalTotalAmount).toBeUndefined()
    expect((projected as any).currentOrderAmount).toBeUndefined()
  })

  it('handles null store and supplier', () => {
    const row = { ...fullRow, store: null, supplier: null }
    const projected = projectOrderRow(row)
    expect(projected.store).toBeNull()
    expect(projected.supplier).toBeNull()
  })

  it('falls back to current items when snapshot is missing', () => {
    const row = { ...fullRow, submittedSnapshot: null }
    const projected = projectOrderRow(row)
    expect(projected.submittedSnapshotItems).toEqual([])
    expect(projected.items[0].productNameSnapshot).toBe('当前白菜')
  })
})

describe('projectDeliveryRow', () => {
  const fullRow = {
    id: 'd1',
    no: 'PS20260701001',
    storeId: 's1',
    supplierId: 'sup1',
    status: 'SHIPPED',
    createdAt: '2026-07-01T10:00:00.000Z',
    shippedAt: '2026-07-01T14:00:00.000Z',
    purchaseOrder: { id: 'o1', no: 'PO20260701001', status: 'CONFIRMED' },
    store: { id: 's1', no: 'S01', name: '门店A' },
    supplier: { id: 'sup1', no: 'SUP01', name: '供应商A' },
    items: [
      { productNameSnapshot: '白菜', productCodeSnapshot: 'BC01', productSpecSnapshot: '500g', product: { name: '当前白菜' } },
      { productNameSnapshot: null, product: { name: '萝卜', code: 'LB01' } },
    ],
    receipt: { id: 'r1', no: 'RK20260701001', totalAmount: 1000 },
    actualTotalAmount: 980,
  }

  it('projects only read-only fields', () => {
    const projected = projectDeliveryRow(fullRow)
    expect(projected.id).toBe('d1')
    expect(projected.no).toBe('PS20260701001')
    expect(projected.status).toBe('SHIPPED')
    expect(projected.shippedAt).toBe('2026-07-01T14:00:00.000Z')
    expect(projected.purchaseOrder).toEqual({ id: 'o1', no: 'PO20260701001' })
    expect(projected.items).toHaveLength(2)
    expect(projected.items[0].productNameSnapshot).toBe('白菜')
  })

  it('excludes financial and write-operation fields', () => {
    const projected = projectDeliveryRow(fullRow)
    expect((projected as any).receipt).toBeUndefined()
    expect((projected as any).actualTotalAmount).toBeUndefined()
  })

  it('falls back to product relation when snapshot is missing', () => {
    const projected = projectDeliveryRow(fullRow)
    expect(projected.items[1].productNameSnapshot).toBe('萝卜')
    expect(projected.items[1].productCodeSnapshot).toBe('LB01')
  })
})

describe('orderItemSummary', () => {
  it('prefers submitted snapshot items', () => {
    const order = projectOrderRow({
      submittedSnapshot: { items: [{ name: '历史白菜' }, { name: '历史萝卜' }] },
      items: [{ productNameSnapshot: '当前白菜' }],
    })
    expect(orderItemSummary(order)).toBe('历史白菜、历史萝卜')
  })

  it('falls back to current items when snapshot is empty', () => {
    const order = projectOrderRow({
      submittedSnapshot: null,
      items: [{ productNameSnapshot: '当前白菜' }, { productNameSnapshot: '当前萝卜' }],
    })
    expect(orderItemSummary(order)).toBe('当前白菜、当前萝卜')
  })

  it('truncates with count when exceeding max', () => {
    const order = projectOrderRow({
      submittedSnapshot: { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] },
      items: [],
    })
    expect(orderItemSummary(order, 3)).toBe('a、b、c 等4项')
  })

  it('returns dash for empty items', () => {
    const order = projectOrderRow({ submittedSnapshot: null, items: [] })
    expect(orderItemSummary(order)).toBe('—')
  })
})

describe('deliveryItemSummary', () => {
  it('uses snapshot names', () => {
    const delivery = projectDeliveryRow({
      items: [
        { productNameSnapshot: '白菜', product: { name: '当前白菜' } },
        { productNameSnapshot: '萝卜', product: { name: '当前萝卜' } },
      ],
    })
    expect(deliveryItemSummary(delivery)).toBe('白菜、萝卜')
  })

  it('falls back to product names', () => {
    const delivery = projectDeliveryRow({
      items: [{ productNameSnapshot: null, product: { name: '萝卜' } }],
    })
    expect(deliveryItemSummary(delivery)).toBe('萝卜')
  })
})

describe('orderDeliveryDateText', () => {
  it('extracts date portion', () => {
    expect(orderDeliveryDateText('2026-07-01T00:00:00.000Z')).toBe('2026-07-01')
  })

  it('returns dash for null/undefined', () => {
    expect(orderDeliveryDateText(null)).toBe('—')
    expect(orderDeliveryDateText(undefined)).toBe('—')
  })
})
