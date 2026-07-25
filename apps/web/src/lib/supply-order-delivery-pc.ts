/**
 * 内部供应链 · 订货单与配送单 PC 只读查询 — 共享纯函数
 *
 * 覆盖两类 query 编码/trim、日期验证、各自状态白名单、筛选重置/翻页保留、
 * 分页边界、历史快照优先的商品摘要和只读字段投影。
 */

export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

// ── 订货单 ───────────────────────────────────────────────

export type OrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'DELIVERING'
  | 'PENDING_CONFIRM'
  | 'RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED'

export const ORDER_STATUS_OPTIONS: { value: OrderStatus; label: string }[] = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'SUBMITTED', label: '已提交' },
  { value: 'CONFIRMED', label: '已确认' },
  { value: 'DELIVERING', label: '配送中' },
  { value: 'PENDING_CONFIRM', label: '待确认' },
  { value: 'RECEIVED', label: '已收货' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
]

export type OrderFilters = {
  keyword: string
  storeId: string
  status: OrderStatus | ''
  dateFrom: string
  dateTo: string
  page: number
  pageSize: number
}

export const DEFAULT_ORDER_FILTERS: OrderFilters = {
  keyword: '',
  storeId: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
  pageSize: 20,
}

export function isOrderStatus(value: string): value is OrderStatus {
  return ORDER_STATUS_OPTIONS.some(opt => opt.value === value)
}

/**
 * 将订货单筛选条件序列化为 /api/orders 查询字符串。
 * keyword 自动 trim；空值字段跳过；page/pageSize 始终携带；参数名使用 dateFrom/dateTo。
 */
export function buildOrderQuery(filters: Partial<OrderFilters>): string {
  const params = new URLSearchParams()
  const kw = (filters.keyword ?? '').trim()
  if (kw) params.set('keyword', kw)
  if (filters.storeId) params.set('storeId', filters.storeId)
  if (filters.status && isOrderStatus(filters.status)) params.set('status', filters.status)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = PAGE_SIZE_OPTIONS.some(size => size === filters.pageSize)
    ? filters.pageSize
    : DEFAULT_ORDER_FILTERS.pageSize
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const result = params.toString()
  return result ? `?${result}` : ''
}

export function resetOrderFilterPage(
  current: OrderFilters,
  changes: Partial<OrderFilters>,
): OrderFilters {
  return { ...current, ...changes, page: 1 }
}

export function keepOrderFiltersForPage(
  current: OrderFilters,
  page: number,
): OrderFilters {
  return { ...current, page: Math.max(1, page) }
}

export function hasActiveOrderFilters(filters: OrderFilters): boolean {
  return Boolean(
    filters.keyword.trim()
    || filters.storeId
    || filters.status
    || filters.dateFrom
    || filters.dateTo,
  )
}

// ── 配送单 ───────────────────────────────────────────────

export type DeliveryStatus =
  | 'DRAFT'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'RECEIVED'
  | 'CANCELLED'

export const DELIVERY_STATUS_OPTIONS: { value: DeliveryStatus; label: string }[] = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'DELIVERED', label: '已送达' },
  { value: 'RECEIVED', label: '已收货' },
  { value: 'CANCELLED', label: '已取消' },
]

export type DeliveryFilters = {
  keyword: string
  storeId: string
  status: DeliveryStatus | ''
  dateFrom: string
  dateTo: string
  page: number
  pageSize: number
}

export const DEFAULT_DELIVERY_FILTERS: DeliveryFilters = {
  keyword: '',
  storeId: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
  pageSize: 20,
}

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return DELIVERY_STATUS_OPTIONS.some(opt => opt.value === value)
}

/**
 * 将配送单筛选条件序列化为 /api/deliveries 查询字符串。
 * keyword 自动 trim；空值字段跳过；page/pageSize 始终携带；参数名使用 dateFrom/dateTo。
 */
export function buildDeliveryQuery(filters: Partial<DeliveryFilters>): string {
  const params = new URLSearchParams()
  const kw = (filters.keyword ?? '').trim()
  if (kw) params.set('keyword', kw)
  if (filters.storeId) params.set('storeId', filters.storeId)
  if (filters.status && isDeliveryStatus(filters.status)) params.set('status', filters.status)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = PAGE_SIZE_OPTIONS.some(size => size === filters.pageSize)
    ? filters.pageSize
    : DEFAULT_DELIVERY_FILTERS.pageSize
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const result = params.toString()
  return result ? `?${result}` : ''
}

export function resetDeliveryFilterPage(
  current: DeliveryFilters,
  changes: Partial<DeliveryFilters>,
): DeliveryFilters {
  return { ...current, ...changes, page: 1 }
}

export function keepDeliveryFiltersForPage(
  current: DeliveryFilters,
  page: number,
): DeliveryFilters {
  return { ...current, page: Math.max(1, page) }
}

export function hasActiveDeliveryFilters(filters: DeliveryFilters): boolean {
  return Boolean(
    filters.keyword.trim()
    || filters.storeId
    || filters.status
    || filters.dateFrom
    || filters.dateTo,
  )
}

// ── 共享工具 ─────────────────────────────────────────────

/**
 * 前端阻止反向日期：dateFrom > dateTo 时返回错误文案，否则 null。
 */
export function validateOrderDeliveryDateRange(dateFrom: string, dateTo: string): string | null {
  if (!dateFrom || !dateTo) return null
  if (dateFrom > dateTo) return '开始日期不能晚于结束日期'
  return null
}

/**
 * 分页范围文本：第 start–end 项，共 total 项。
 */
export function orderDeliveryPaginationRange(
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
export function orderDeliveryTotalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

export function formatOrderStatusLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: '草稿',
    SUBMITTED: '已提交',
    CONFIRMED: '已确认',
    DELIVERING: '配送中',
    PENDING_CONFIRM: '待确认',
    RECEIVED: '已收货',
    COMPLETED: '已完成',
    CANCELLED: '已取消',
  }
  return map[status] || status
}

export function formatDeliveryStatusLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: '草稿',
    SHIPPED: '已发货',
    DELIVERED: '已送达',
    RECEIVED: '已收货',
    CANCELLED: '已取消',
  }
  return map[status] || status
}

export function orderStatusTone(status: string): 'green' | 'gray' | 'orange' | 'red' | 'blue' {
  if (status === 'COMPLETED' || status === 'CONFIRMED') return 'green'
  if (status === 'CANCELLED') return 'red'
  if (status === 'SUBMITTED' || status === 'DELIVERING' || status === 'PENDING_CONFIRM' || status === 'RECEIVED') return 'orange'
  return 'gray'
}

export function deliveryStatusTone(status: string): 'green' | 'gray' | 'orange' | 'red' | 'blue' {
  if (status === 'RECEIVED') return 'green'
  if (status === 'CANCELLED') return 'red'
  if (status === 'SHIPPED' || status === 'DELIVERED') return 'orange'
  return 'gray'
}

// ── 只读字段投影 ─────────────────────────────────────────

type SnapshotItem = {
  name?: string | null
  code?: string | null
  spec?: string | null
}

type ProductRelation = {
  name?: string | null
  code?: string | null
  spec?: string | null
}

type DocumentItem = {
  productNameSnapshot?: string | null
  productCodeSnapshot?: string | null
  productSpecSnapshot?: string | null
  product?: ProductRelation | null
}

function projectDocumentItem(item: DocumentItem) {
  return {
    productNameSnapshot: item.productNameSnapshot ?? item.product?.name ?? null,
    productCodeSnapshot: item.productCodeSnapshot ?? item.product?.code ?? null,
    productSpecSnapshot: item.productSpecSnapshot ?? item.product?.spec ?? null,
  }
}

/**
 * 订货单只读字段投影。
 * 明确排除 paymentSchedule、invoice、银行、应付/核对/营业额/成本率字段及写操作按钮所需数据。
 */
export function projectOrderRow(row: any) {
  const submittedSnapshotItems: SnapshotItem[] = Array.isArray(row.submittedSnapshot?.items)
    ? row.submittedSnapshot.items
    : []

  return {
    id: row.id,
    no: row.no,
    storeId: row.storeId,
    supplierId: row.supplierId,
    status: row.status,
    createdAt: row.createdAt,
    expectedDeliveryDate: row.expectedDeliveryDate,
    store: row.store ? { id: row.store.id, name: row.store.name, no: row.store.no } : null,
    supplier: row.supplier ? { id: row.supplier.id, name: row.supplier.name, no: row.supplier.no } : null,
    submittedSnapshotItems,
    items: Array.isArray(row.items) ? row.items.map(projectDocumentItem) : [],
  }
}

export type ProjectedOrder = ReturnType<typeof projectOrderRow>

/**
 * 配送单只读字段投影。
 * 明确排除 paymentSchedule、invoice、银行、应付/核对/营业额/成本率字段及写操作按钮所需数据。
 */
export function projectDeliveryRow(row: any) {
  return {
    id: row.id,
    no: row.no,
    storeId: row.storeId,
    supplierId: row.supplierId,
    status: row.status,
    createdAt: row.createdAt,
    shippedAt: row.shippedAt,
    purchaseOrder: row.purchaseOrder
      ? { id: row.purchaseOrder.id, no: row.purchaseOrder.no }
      : null,
    store: row.store ? { id: row.store.id, name: row.store.name, no: row.store.no } : null,
    supplier: row.supplier ? { id: row.supplier.id, name: row.supplier.name, no: row.supplier.no } : null,
    items: Array.isArray(row.items) ? row.items.map(projectDocumentItem) : [],
  }
}

export type ProjectedDelivery = ReturnType<typeof projectDeliveryRow>

// ── 商品摘要 ─────────────────────────────────────────────

/**
 * 订货单商品摘要：优先使用首次提交历史快照，快照缺失时回退到当前商品。
 */
export function orderItemSummary(order: ProjectedOrder, max = 3): string {
  const snapshotNames = order.submittedSnapshotItems
    .map(item => item.name)
    .filter(Boolean) as string[]
  if (snapshotNames.length > 0) {
    const shown = snapshotNames.slice(0, max).join('、')
    return snapshotNames.length > max ? `${shown} 等${snapshotNames.length}项` : shown
  }
  return documentItemSummary(order.items, max)
}

/**
 * 配送单商品摘要：优先使用配送时的商品快照，缺失时回退到当前商品。
 */
export function deliveryItemSummary(delivery: ProjectedDelivery, max = 3): string {
  return documentItemSummary(delivery.items, max)
}

function documentItemSummary(
  items: { productNameSnapshot?: string | null }[],
  max = 3,
): string {
  if (!items || items.length === 0) return '—'
  const names = items
    .map(item => item.productNameSnapshot)
    .filter(Boolean) as string[]
  if (names.length === 0) return '—'
  const shown = names.slice(0, max).join('、')
  return names.length > max ? `${shown} 等${names.length}项` : shown
}

/**
 * 日期文本：取前 10 位（YYYY-MM-DD）。
 */
export function orderDeliveryDateText(value?: string | null): string {
  return value ? value.slice(0, 10) : '—'
}
