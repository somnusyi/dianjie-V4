/**
 * 内部供应链 · 商品 PC 台 — 批量/导出/选择纯函数
 *
 * 覆盖：行选择生命周期、当前筛选导出、批量分类/停售/恢复。
 * 所有批量提交文案由调用方明确为“直接生效并通知总厨”。
 * 只调用真实存在的端点：
 *   GET  /api/products/export.csv
 *   POST /api/products/batch-status/preview
 *   PATCH /api/products/batch-status
 *   PATCH /api/products/batch-category
 */

import type { SupplyProductFilters } from './supply-product-pc'

export type BatchStatus = 'ENABLED' | 'DISABLED'

export type BatchStatusPreview = {
  requested: number
  impacted: number
  alreadyInTargetStatus: number
  activeReservationSku: number
  activeReservationQty: number
  recent28DayOrders: number
  recent28DayOrderLines: number
  physicalStockValue: number
  sample: Array<{ id: string; name: string; stock: number; reserved: number }>
}

export function toggleRowSelection(selection: Set<string>, id: string): Set<string> {
  const next = new Set(selection)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectPageRows(selection: Set<string>, pageIds: string[], checked: boolean): Set<string> {
  const next = new Set(selection)
  if (checked) {
    pageIds.forEach(id => next.add(id))
  } else {
    pageIds.forEach(id => next.delete(id))
  }
  return next
}

export function clearRowSelection(): Set<string> {
  return new Set()
}

/**
 * 导出当前筛选的查询字符串。
 * 复用与列表完全一致的 q/category/status/supplierId，不带 page/pageSize。
 */
export function buildSupplyProductExportSearch(
  filters: Pick<SupplyProductFilters, 'q' | 'category' | 'status' | 'supplierId'>,
): string {
  const params = new URLSearchParams()
  if (filters.q?.trim()) params.set('q', filters.q.trim())
  if (filters.category) params.set('category', filters.category)
  if (filters.status) params.set('status', filters.status)
  if (filters.supplierId) params.set('supplierId', filters.supplierId)
  return params.toString()
}

export function buildSupplyProductExportPath(filters: Pick<SupplyProductFilters, 'q' | 'category' | 'status' | 'supplierId'>): string {
  const search = buildSupplyProductExportSearch(filters)
  return '/api/products/export.csv' + (search ? `?${search}` : '')
}

export function productExportFilename(date = new Date()): string {
  const china = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return `商品报价表_${china.replace(/\//g, '-')}.csv`
}

/**
 * 批量分类是否允许。
 * 内部供应链跨供应商时无法证明分类对每家供应商都有效，必须先限定供应商。
 */
export function canBulkCategory(filters: Pick<SupplyProductFilters, 'supplierId'>): boolean {
  return Boolean(filters.supplierId)
}

export function bulkCategoryBlockedReason(filters: Pick<SupplyProductFilters, 'supplierId'>): string | null {
  if (canBulkCategory(filters)) return null
  return '批量分类前请先在“供应商”筛选中限定一个供应商，避免跨供应商分类不一致。'
}

export function buildBatchCategoryBody(ids: string[], category: string): { ids: string[]; category: string } {
  return { ids: [...new Set(ids)], category: category.trim() }
}

export function buildBatchStatusPreviewBody(ids: string[], status: BatchStatus): { ids: string[]; status: BatchStatus } {
  return { ids: [...new Set(ids)], status }
}

export function buildBatchStatusBody(ids: string[], status: BatchStatus): { ids: string[]; status: BatchStatus } {
  return { ids: [...new Set(ids)], status }
}

export function formatBatchStatusPreviewSummary(impact: BatchStatusPreview): string {
  const lines = [
    `实际影响 ${impact.impacted} 个 SKU，已有 ${impact.alreadyInTargetStatus} 个无需变更。`,
    `当前库存货值 ¥${impact.physicalStockValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}。`,
    impact.activeReservationSku > 0
      ? `其中 ${impact.activeReservationSku} 个 SKU 已被订单占用，共 ${impact.activeReservationQty}；现有订单仍会继续履约。`
      : '当前没有有效订单预占。',
    `近 28 天涉及 ${impact.recent28DayOrders} 张订货单。`,
  ]
  return lines.join('\n')
}

export function buildBatchSuccessNotice(action: 'category' | 'disable' | 'restore', count: number): string {
  const map = {
    category: `批量分类已完成 ${count} 项，已直接生效并通知总厨。`,
    disable: `批量停售已完成 ${count} 项，已直接生效并通知总厨。`,
    restore: `批量恢复供应已完成 ${count} 项，已直接生效并通知总厨。`,
  }
  return map[action]
}

/**
 * 批量成功后的统一清理：返回空选择集，方便调用方刷新列表。
 */
export function clearSelectionAfterSuccess(): { selection: Set<string> } {
  return { selection: new Set() }
}
