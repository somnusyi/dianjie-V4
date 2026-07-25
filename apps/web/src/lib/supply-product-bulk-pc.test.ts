import { describe, expect, it } from 'vitest'
import {
  buildBatchCategoryBody,
  buildBatchStatusBody,
  buildBatchStatusPreviewBody,
  buildBatchSuccessNotice,
  buildSupplyProductExportPath,
  buildSupplyProductExportSearch,
  bulkCategoryBlockedReason,
  canBulkCategory,
  clearRowSelection,
  clearSelectionAfterSuccess,
  formatBatchStatusPreviewSummary,
  productExportFilename,
  selectPageRows,
  toggleRowSelection,
  type BatchStatusPreview,
} from './supply-product-bulk-pc'

describe('selection lifecycle', () => {
  it('toggles a row in and out', () => {
    expect(toggleRowSelection(new Set(), 'a')).toEqual(new Set(['a']))
    expect(toggleRowSelection(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']))
  })

  it('selects all current page rows when checked', () => {
    const next = selectPageRows(new Set(['x']), ['a', 'b', 'c'], true)
    expect(next).toEqual(new Set(['x', 'a', 'b', 'c']))
  })

  it('clears only current page rows when unchecked', () => {
    const next = selectPageRows(new Set(['a', 'b', 'x']), ['a', 'b'], false)
    expect(next).toEqual(new Set(['x']))
  })

  it('returns a new set instance on each operation', () => {
    const before = new Set(['a'])
    const after = toggleRowSelection(before, 'b')
    expect(after).not.toBe(before)
    expect(before).toEqual(new Set(['a']))
  })

  it('clears selection to empty set', () => {
    expect(clearRowSelection()).toEqual(new Set())
  })

  it('success cleanup returns empty selection', () => {
    expect(clearSelectionAfterSuccess()).toEqual({ selection: new Set() })
  })
})

describe('export search params', () => {
  it('returns empty string with no filters', () => {
    expect(buildSupplyProductExportSearch({ q: '', category: '', status: '', supplierId: '' })).toBe('')
  })

  it('encodes keyword and trims whitespace', () => {
    expect(buildSupplyProductExportSearch({ q: '  鲜虾 白菜  ', category: '', status: '', supplierId: '' }))
      .toBe('q=%E9%B2%9C%E8%99%BE+%E7%99%BD%E8%8F%9C')
  })

  it('includes category, status and supplierId', () => {
    const search = buildSupplyProductExportSearch({ q: '', category: '蔬菜', status: 'ENABLED', supplierId: 'sup-1' })
    expect(search).toContain('category=%E8%94%AC%E8%8F%9C')
    expect(search).toContain('status=ENABLED')
    expect(search).toContain('supplierId=sup-1')
    expect(search).not.toContain('q=')
  })

  it('combines all active filters', () => {
    const search = buildSupplyProductExportSearch({ q: '虾', category: '冻品', status: 'DISABLED', supplierId: 'sup-2' })
    expect(search).toContain('q=%E8%99%BE')
    expect(search).toContain('category=%E5%86%BB%E5%93%81')
    expect(search).toContain('status=DISABLED')
    expect(search).toContain('supplierId=sup-2')
  })

  it('builds export path without query when no filters', () => {
    expect(buildSupplyProductExportPath({ q: '', category: '', status: '', supplierId: '' }))
      .toBe('/api/products/export.csv')
  })

  it('builds export path with query when filters active', () => {
    const path = buildSupplyProductExportPath({ q: '白菜', category: '', status: 'ENABLED', supplierId: '' })
    expect(path).toBe('/api/products/export.csv?q=%E7%99%BD%E8%8F%9C&status=ENABLED')
  })

  it('does not include page or pageSize in export search', () => {
    const search = buildSupplyProductExportSearch({ q: 'x', category: 'y', status: 'ENABLED', supplierId: 'z' })
    expect(search).not.toContain('page=')
    expect(search).not.toContain('pageSize=')
  })
})

describe('export filename', () => {
  it('uses China business date suffix (Asia/Shanghai)', () => {
    expect(productExportFilename(new Date('2026-07-25T10:38:55.883Z'))).toBe('商品报价表_2026-07-25.csv')
    expect(productExportFilename(new Date('2026-07-25T16:00:00.000Z'))).toBe('商品报价表_2026-07-26.csv')
  })
})

describe('cross-supplier category guard', () => {
  it('allows bulk category when supplier is selected', () => {
    expect(canBulkCategory({ supplierId: 'sup-1' })).toBe(true)
    expect(bulkCategoryBlockedReason({ supplierId: 'sup-1' })).toBeNull()
  })

  it('blocks bulk category when no supplier is selected', () => {
    expect(canBulkCategory({ supplierId: '' })).toBe(false)
    expect(bulkCategoryBlockedReason({ supplierId: '' })).toContain('请先')
    expect(bulkCategoryBlockedReason({ supplierId: '' })).toContain('供应商')
  })
})

describe('batch request mapping', () => {
  it('maps batch category body with deduped ids and trimmed category', () => {
    expect(buildBatchCategoryBody(['a', 'b', 'a'], '  蔬菜  ')).toEqual({ ids: ['a', 'b'], category: '蔬菜' })
  })

  it('maps batch status preview body', () => {
    expect(buildBatchStatusPreviewBody(['a', 'b', 'a'], 'DISABLED')).toEqual({ ids: ['a', 'b'], status: 'DISABLED' })
  })

  it('maps batch status submit body', () => {
    expect(buildBatchStatusBody(['x', 'y', 'y'], 'ENABLED')).toEqual({ ids: ['x', 'y'], status: 'ENABLED' })
  })
})

describe('batch status preview summary', () => {
  it('formats full impact summary', () => {
    const impact: BatchStatusPreview = {
      requested: 5,
      impacted: 3,
      alreadyInTargetStatus: 2,
      activeReservationSku: 1,
      activeReservationQty: 12.5,
      recent28DayOrders: 4,
      recent28DayOrderLines: 8,
      physicalStockValue: 1234.56,
      sample: [{ id: 'p1', name: '白菜', stock: 10, reserved: 2 }],
    }
    const summary = formatBatchStatusPreviewSummary(impact)
    expect(summary).toContain('实际影响 3 个 SKU')
    expect(summary).toContain('已有 2 个无需变更')
    expect(summary).toContain('当前库存货值 ¥1,234.56')
    expect(summary).toContain('1 个 SKU 已被订单占用')
    expect(summary).toContain('共 12.5')
    expect(summary).toContain('近 28 天涉及 4 张订货单')
  })

  it('notes no active reservations when zero', () => {
    const impact: BatchStatusPreview = {
      requested: 2,
      impacted: 2,
      alreadyInTargetStatus: 0,
      activeReservationSku: 0,
      activeReservationQty: 0,
      recent28DayOrders: 0,
      recent28DayOrderLines: 0,
      physicalStockValue: 0,
      sample: [],
    }
    const summary = formatBatchStatusPreviewSummary(impact)
    expect(summary).toContain('当前没有有效订单预占')
    expect(summary).not.toContain('已被订单占用')
  })
})

describe('batch success notice', () => {
  it('states category batch takes effect directly', () => {
    expect(buildBatchSuccessNotice('category', 7)).toContain('批量分类已完成 7 项')
    expect(buildBatchSuccessNotice('category', 7)).toContain('直接生效并通知总厨')
  })

  it('states disable batch takes effect directly', () => {
    expect(buildBatchSuccessNotice('disable', 3)).toContain('批量停售已完成 3 项')
    expect(buildBatchSuccessNotice('disable', 3)).toContain('直接生效并通知总厨')
  })

  it('states restore batch takes effect directly', () => {
    expect(buildBatchSuccessNotice('restore', 5)).toContain('批量恢复供应已完成 5 项')
    expect(buildBatchSuccessNotice('restore', 5)).toContain('直接生效并通知总厨')
  })
})
