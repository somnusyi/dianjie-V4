/**
 * 门店消耗记录 · PC 分页查询纯函数
 *
 * 负责把筛选/分页状态序列化为 /api/inventory/consumptions 查询串、
 * 翻页时保留条件、筛选变化时重置页码、计算分页范围等。
 * 页面组件消费这些函数，避免只有 UI 测试。
 */

export const CONSUMPTION_PAGE_SIZE_OPTIONS = [20, 50, 100] as const

export type ConsumptionPageSize = typeof CONSUMPTION_PAGE_SIZE_OPTIONS[number]

export type ConsumptionFilters = {
  storeId: string
  q: string
  startDate: string
  endDate: string
  page: number
  pageSize: ConsumptionPageSize
}

export const DEFAULT_CONSUMPTION_FILTERS: ConsumptionFilters = {
  storeId: '',
  q: '',
  startDate: '',
  endDate: '',
  page: 1,
  pageSize: 20,
}

export type ConsumptionPaginatedResponse<T = unknown> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/**
 * 将筛选条件序列化为 /api/inventory/consumptions 查询字符串。
 * - 关键字自动 trim；空值字段跳过；
 * - page/pageSize/storeId 始终携带；
 * - page 至少为 1；pageSize 只能是 20/50/100，否则回退到默认值。
 */
export function buildConsumptionQuery(filters: Partial<ConsumptionFilters>): string {
  const params = new URLSearchParams()
  const storeId = (filters.storeId ?? '').trim()
  if (storeId) params.set('storeId', storeId)

  const q = (filters.q ?? '').trim()
  if (q) params.set('q', q)

  if (filters.startDate) params.set('startDate', filters.startDate)
  if (filters.endDate) params.set('endDate', filters.endDate)

  const page = Math.max(1, filters.page ?? 1)
  const pageSize = isValidConsumptionPageSize(filters.pageSize)
    ? filters.pageSize
    : DEFAULT_CONSUMPTION_FILTERS.pageSize

  params.set('page', String(page))
  params.set('pageSize', String(pageSize))

  const result = params.toString()
  return result ? `?${result}` : ''
}

function isValidConsumptionPageSize(value: unknown): value is ConsumptionPageSize {
  return CONSUMPTION_PAGE_SIZE_OPTIONS.some(size => size === value)
}

/**
 * 筛选条件变化时重置到第 1 页，保留其余筛选。
 * 翻页操作不应调用此函数。
 */
export function resetConsumptionFilterPage(
  current: ConsumptionFilters,
  changes: Partial<ConsumptionFilters>,
): ConsumptionFilters {
  return normalizeConsumptionFilters({ ...current, ...changes, page: 1 })
}

/**
 * 翻页时保留全部筛选条件，只更新 page。
 */
export function keepConsumptionFiltersForPage(
  current: ConsumptionFilters,
  page: number,
): ConsumptionFilters {
  return normalizeConsumptionFilters({ ...current, page })
}

function normalizeConsumptionFilters(filters: Partial<ConsumptionFilters>): ConsumptionFilters {
  return {
    storeId: (filters.storeId ?? '').trim(),
    q: (filters.q ?? '').trim(),
    startDate: filters.startDate ?? '',
    endDate: filters.endDate ?? '',
    page: Math.max(1, filters.page ?? 1),
    pageSize: isValidConsumptionPageSize(filters.pageSize)
      ? filters.pageSize
      : DEFAULT_CONSUMPTION_FILTERS.pageSize,
  }
}

/**
 * 前端阻止反向日期：startDate > endDate 时返回错误文案，否则 null。
 */
export function validateConsumptionDateRange(startDate: string, endDate: string): string | null {
  if (!startDate || !endDate) return null
  if (startDate > endDate) return '开始日期不能晚于结束日期'
  return null
}

/**
 * 判断是否有活跃的筛选条件（用于"清空"按钮禁用态）。
 */
export function hasActiveConsumptionFilters(filters: ConsumptionFilters): boolean {
  return Boolean(
    filters.q.trim()
    || filters.startDate
    || filters.endDate,
  )
}

/**
 * 分页范围文本：第 start–end 项，共 total 项。
 */
export function consumptionPaginationRange(
  page: number,
  pageSize: number,
  total: number,
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 }
  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  return { start, end }
}

/**
 * 总页数。
 */
export function consumptionTotalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * 判断给定页码是否在有效范围内。
 */
export function isValidConsumptionPage(page: number, total: number, pageSize: number): boolean {
  if (page < 1 || total <= 0) return false
  return page <= consumptionTotalPages(total, pageSize)
}
