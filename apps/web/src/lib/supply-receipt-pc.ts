/**
 * 内部供应链 · 收货查询桌面端 — 纯函数
 *
 * 查询编码 / trim / 反向日期阻止 / 筛选重置页码 / 翻页保留条件 /
 * 分页范围 / 只读字段投影。页面组件消费这些函数，避免只有静态字符串测试。
 */

export type ReceiptStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'PENDING_CONFIRM'
  | 'CONFIRMED'
  | 'ACCOUNTED'
  | 'VOID'
  | 'REJECTED'

export const RECEIPT_STATUS_OPTIONS: { value: ReceiptStatus; label: string }[] = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'PENDING', label: '待送达' },
  { value: 'PENDING_CONFIRM', label: '待确认' },
  { value: 'CONFIRMED', label: '已确认' },
  { value: 'ACCOUNTED', label: '已入账' },
  { value: 'VOID', label: '已作废' },
  { value: 'REJECTED', label: '已拒收' },
]

export type ReceiptFilters = {
  keyword: string
  storeId: string
  dateFrom: string
  dateTo: string
  page: number
  pageSize: number
}

export const DEFAULT_RECEIPT_FILTERS: ReceiptFilters = {
  keyword: '',
  storeId: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
  pageSize: 20,
}

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

export { PAGE_SIZE_OPTIONS }

/**
 * 将筛选条件序列化为 /api/receipts 查询字符串。
 * keyword 自动 trim；空值字段跳过；page/pageSize 始终携带。
 */
export function buildReceiptQuery(filters: Partial<ReceiptFilters>): string {
  const params = new URLSearchParams()
  const kw = (filters.keyword ?? '').trim()
  if (kw) params.set('keyword', kw)
  if (filters.storeId) params.set('storeId', filters.storeId)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = PAGE_SIZE_OPTIONS.some(size => size === filters.pageSize)
    ? filters.pageSize
    : DEFAULT_RECEIPT_FILTERS.pageSize
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const result = params.toString()
  return result ? `?${result}` : ''
}

/**
 * 筛选条件变化时重置到第 1 页，保留其余筛选。
 * 翻页操作不应调用此函数。
 */
export function resetReceiptFilterPage(
  current: ReceiptFilters,
  changes: Partial<ReceiptFilters>,
): ReceiptFilters {
  return { ...current, ...changes, page: 1 }
}

/**
 * 翻页时保留全部筛选条件，只更新 page。
 */
export function keepReceiptFiltersForPage(
  current: ReceiptFilters,
  page: number,
): ReceiptFilters {
  return { ...current, page: Math.max(1, page) }
}

/**
 * 前端阻止反向日期：dateFrom > dateTo 时返回错误文案，否则 null。
 */
export function validateReceiptDateRange(dateFrom: string, dateTo: string): string | null {
  if (!dateFrom || !dateTo) return null
  if (dateFrom > dateTo) return '开始日期不能晚于结束日期'
  return null
}

/**
 * 判断是否有活跃的筛选条件（用于"清空"按钮禁用态）。
 */
export function hasActiveReceiptFilters(filters: ReceiptFilters): boolean {
  return Boolean(
    filters.keyword.trim()
    || filters.storeId
    || filters.dateFrom
    || filters.dateTo,
  )
}

/**
 * 分页范围文本：第 start–end 项，共 total 项。
 */
export function receiptPaginationRange(
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
export function receiptTotalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * 收货状态展示文案。
 */
export function formatReceiptStatusLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: '草稿',
    PENDING: '待送达',
    PENDING_CONFIRM: '待确认',
    CONFIRMED: '已确认',
    ACCOUNTED: '已入账',
    VOID: '已作废',
    REJECTED: '已拒收',
  }
  return map[status] || status
}

/**
 * 收货状态 Chip 色调。
 */
export function receiptStatusTone(status: string): 'green' | 'gray' | 'orange' | 'red' | 'blue' {
  if (status === 'CONFIRMED' || status === 'ACCOUNTED') return 'green'
  if (status === 'VOID' || status === 'REJECTED') return 'red'
  if (status === 'PENDING' || status === 'PENDING_CONFIRM') return 'orange'
  return 'gray'
}

type ReceiptItem = {
  productNameSnapshot?: string | null
  productCodeSnapshot?: string | null
  productSpecSnapshot?: string | null
  product?: { name?: string; code?: string; spec?: string }
}

/**
 * 只读字段投影：从 API 响应中提取列表展示所需字段，
 * 明确排除 paymentSchedule、invoice、银行、应付/核对字段。
 */
export function projectReceiptRow(row: any) {
  return {
    id: row.id,
    no: row.no,
    storeId: row.storeId,
    status: row.status,
    deliveryDate: row.deliveryDate,
    note: row.note,
    createdAt: row.createdAt,
    store: row.store ? { id: row.store.id, name: row.store.name, no: row.store.no } : null,
    supplier: row.supplier ? { id: row.supplier.id, name: row.supplier.name, no: row.supplier.no } : null,
    items: Array.isArray(row.items) ? row.items.map(projectReceiptItem) : [],
  }
}

function projectReceiptItem(item: ReceiptItem) {
  return {
    productNameSnapshot: item.productNameSnapshot ?? item.product?.name ?? null,
    productCodeSnapshot: item.productCodeSnapshot ?? item.product?.code ?? null,
    productSpecSnapshot: item.productSpecSnapshot ?? item.product?.spec ?? null,
  }
}

/**
 * 商品摘要：取前 N 个商品名称拼接。
 */
export function receiptItemSummary(items: { productNameSnapshot?: string | null }[], max = 3): string {
  if (!items || items.length === 0) return '—'
  const names = items
    .map(item => item.productNameSnapshot)
    .filter(Boolean) as string[]
  if (names.length === 0) return '—'
  const shown = names.slice(0, max).join('、')
  return names.length > max ? `${shown} 等${names.length}项` : shown
}

/**
 * 金额格式化。
 */
export function formatReceiptMoney(value: unknown): string {
  if (value == null) return '—'
  const amount = Number(value)
  return Number.isFinite(amount)
    ? `¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
}

/**
 * 日期文本：取前 10 位（YYYY-MM-DD）。
 */
export function receiptDateText(value?: string | null): string {
  return value ? value.slice(0, 10) : '—'
}
