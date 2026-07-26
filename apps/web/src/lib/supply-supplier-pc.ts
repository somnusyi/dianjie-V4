/**
 * 内部供应链 · 供应商管理桌面端 — 纯函数
 *
 * 只依赖现有 GET /api/suppliers 与 PATCH /api/suppliers/:id/toggle。
 * 不引入新接口；不暴露银行账号、密钥等敏感字段。
 */

export const SUPPLY_SUPPLIER_STATUS_OPTIONS = [
  { value: 'ENABLED', label: '启用中' },
  { value: 'DISABLED', label: '已停用' },
] as const

export type SupplySupplierStatus = 'ENABLED' | 'DISABLED'

export type SupplySupplier = {
  id: string
  no: string
  name: string
  category?: string | null
  status: SupplySupplierStatus
  contactName?: string | null
  contactPhone?: string | null
  creditType?: string | null
  creditDays?: number | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type SupplySupplierFilters = {
  q: string
  status: string
  page: number
  pageSize: number
}

export const DEFAULT_SUPPLY_SUPPLIER_FILTERS: SupplySupplierFilters = {
  q: '',
  status: '',
  page: 1,
  pageSize: 20,
}

export const SENSITIVE_SUPPLIER_FIELDS = [
  'bankName',
  'bankAccount',
  'bankAccountName',
  'bankCode',
  'autoPay',
  'autoPayLimit',
] as const

/**
 * 供应商状态 → 展示文案。
 */
export function formatSupplierStatusLabel(status?: string | null): string {
  switch (status) {
    case 'ENABLED': return '启用中'
    case 'DISABLED': return '已停用'
    default: return status || '未知状态'
  }
}

/**
 * 供应商状态 → 视觉 tone。
 */
export function supplierStatusTone(status?: string | null): 'green' | 'gray' {
  switch (status) {
    case 'ENABLED': return 'green'
    case 'DISABLED': return 'gray'
    default: return 'gray'
  }
}

/**
 * 账期展示：优先展示固定天数，其余账期类型显示中文占位。
 */
export function formatCreditDays(supplier?: { creditType?: string | null; creditDays?: number | null } | null): string {
  if (!supplier) return '—'
  if (supplier.creditType && supplier.creditType !== 'FIXED_DAYS') {
    return '按协议'
  }
  if (supplier.creditDays == null) return '—'
  return `${supplier.creditDays} 天`
}

/**
 * 本地关键字筛选（名称或编号）。
 * 服务端 /api/suppliers 暂不支持关键字搜索，由页面在获取全量后本地过滤。
 */
export function filterSuppliersByLocalSearch(suppliers: SupplySupplier[], q: string): SupplySupplier[] {
  const keyword = q.trim().toLowerCase()
  if (!keyword) return suppliers
  return suppliers.filter(s =>
    s.name.toLowerCase().includes(keyword) ||
    s.no.toLowerCase().includes(keyword),
  )
}

/**
 * 本地状态筛选。
 */
export function filterSuppliersByStatus(suppliers: SupplySupplier[], status: string): SupplySupplier[] {
  if (!status) return suppliers
  return suppliers.filter(s => s.status === status)
}

/**
 * 按创建时间升序排列（兜底：若创建时间缺失则保持原序）。
 */
export function sortSuppliersByCreatedAt(suppliers: SupplySupplier[]): SupplySupplier[] {
  return [...suppliers].sort((a, b) => {
    if (!a.createdAt && !b.createdAt) return 0
    if (!a.createdAt) return 1
    if (!b.createdAt) return -1
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
}

/**
 * 应用全部本地筛选与排序。
 */
export function applySupplierFilters(
  suppliers: SupplySupplier[],
  filters: Pick<SupplySupplierFilters, 'q' | 'status'>,
): SupplySupplier[] {
  const byStatus = filterSuppliersByStatus(suppliers, filters.status)
  const bySearch = filterSuppliersByLocalSearch(byStatus, filters.q)
  return sortSuppliersByCreatedAt(bySearch)
}

/**
 * 客户端分页。
 */
export function paginateSuppliers(suppliers: SupplySupplier[], page: number, pageSize: number): SupplySupplier[] {
  const start = (page - 1) * pageSize
  return suppliers.slice(start, start + pageSize)
}

/**
 * 筛选条件变化时重置到第 1 页，保留其余筛选。
 */
export function resetPageFilters(
  current: SupplySupplierFilters,
  changes: Partial<SupplySupplierFilters>,
): SupplySupplierFilters {
  return { ...current, ...changes, page: 1 }
}

/**
 * 翻页时保留全部筛选条件，只更新 page。
 */
export function keepFiltersForPage(current: SupplySupplierFilters, page: number): SupplySupplierFilters {
  return { ...current, page }
}

/**
 * 判断当前是否有激活的筛选条件。
 */
export function hasActiveFilters(filters: SupplySupplierFilters): boolean {
  return Boolean(filters.q.trim() || filters.status)
}

/**
 * 详情区统计：当前 /api/suppliers 不返回商品数量，明确显示“待接入”。
 */
export function getSupplierDetailStats(_supplier: SupplySupplier | null): {
  productCount: null
  productCountLabel: string
} {
  return { productCount: null, productCountLabel: '待接入' }
}

/**
 * 检测供应商对象是否包含敏感字段（用于测试与防御性断言）。
 */
export function hasSensitiveSupplierFields(supplier: Record<string, unknown>): boolean {
  return SENSITIVE_SUPPLIER_FIELDS.some(field => field in supplier)
}
