/**
 * 内部供应链 · 商品管理桌面端 — 纯函数
 *
 * 查询参数构建 / 分页保留筛选 / 动作请求映射 / 图片兜底 / 角色路径。
 * 只依赖现有 /api/products 与 /api/suppliers 端点，不引入新接口。
 */

/** 商品数量字段统一使用非负、最多三位小数；起订量必须大于 0。 */
const QUANTITY_INPUT_REGEX = /^\d+(\.\d{1,3})?$/
const PRODUCT_QUANTITY_MAX = 999_999_999.999

export const SUPPLY_PRODUCT_STATUS_OPTIONS = [
  { value: 'ENABLED', label: '供应中' },
  { value: 'DISABLED', label: '已停售' },
] as const

export type SupplyProductStatus = 'ENABLED' | 'DISABLED' | 'PENDING_APPROVAL' | 'PENDING_DISABLE'

export type SupplyProductFilters = {
  q: string
  category: string
  status: string
  supplierId: string
  page: number
  pageSize: number
}

export const DEFAULT_SUPPLY_PRODUCT_FILTERS: SupplyProductFilters = {
  q: '',
  category: '',
  status: '',
  supplierId: '',
  page: 1,
  pageSize: 20,
}

export type SupplyProduct = {
  id: string
  code: string
  name: string
  spec: string | null
  category: string | null
  unit: string
  price: number | string
  status: string
  imageKey: string | null
  imageUrl: string | null
  supplier: { id: string; name: string } | null
}

export type CategoryOption = { name: string; count: number }

export type SupplierOption = { id: string; name: string }

/** 四位商品数量字段的表单类型（库存、安全库存、起订量、步长）。 */
export type SupplyProductQuantityForm = {
  stock: string
  minStock: string
  minOrderQty: string
  stepQty: string
}

/**
 * 将用户输入解析为非负有限数，最多三位小数。
 * 拒绝空值、负数、NaN/Infinity、科学计数法及超过三位小数。
 */
export function parseProductQuantity(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!QUANTITY_INPUT_REGEX.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n > PRODUCT_QUANTITY_MAX) return null
  return n
}

/**
 * 校验单个数量字段；返回错误文案或 null。
 * positive=true 时要求必须大于 0（用于起订量）。
 */
export function validateProductQuantity(
  value: string,
  label: string,
  { positive }: { positive?: boolean } = {},
): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return `${label}必填`
  if (/e/i.test(trimmed)) return `${label}不能使用科学计数法`
  if (trimmed.startsWith('-')) return `${label}不能为负数`
  if (!QUANTITY_INPUT_REGEX.test(trimmed)) {
    if (/\.\d{4,}/.test(trimmed)) return `${label}最多三位小数`
    return `${label}必须是非负数字，最多三位小数`
  }
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return `${label}必须是有限数字`
  if (n > PRODUCT_QUANTITY_MAX) return `${label}超过商品数量上限`
  if (positive && n <= 0) return `${label}必须大于 0`
  return null
}

/** 校验库存、安全库存、起订量、步长；返回第一条错误文案或 null。 */
export function validateProductQuantities(
  form: SupplyProductQuantityForm,
): string | null {
  return (
    validateProductQuantity(form.stock, '库存') ||
    validateProductQuantity(form.minStock, '安全库存') ||
    validateProductQuantity(form.minOrderQty, '起订量', { positive: true }) ||
    validateProductQuantity(form.stepQty, '步长', { positive: true }) ||
    null
  )
}

/** 列表/回填展示：保留服务端返回的有效数字字符串，否则按最多三位小数格式化。 */
export function formatProductQuantity(value: unknown): string {
  if (value == null || value === '') return '—'
  const s = typeof value === 'string' ? value.trim() : String(value)
  if (s === '') return '—'
  if (typeof value === 'string' && QUANTITY_INPUT_REGEX.test(s)) return s
  const n = Number(s)
  return Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { maximumFractionDigits: 3 })
    : '—'
}

/**
 * 将筛选条件 + 分页序列化为 /api/products 查询字符串。
 * 空值字段自动跳过；供应商筛选必须由后端执行，确保总数与跨页结果一致。
 */
export function buildProductQuery(filters: Partial<SupplyProductFilters>): string {
  const params = new URLSearchParams()
  if (filters.q?.trim()) params.set('q', filters.q.trim())
  if (filters.category) params.set('category', filters.category)
  if (filters.status) params.set('status', filters.status)
  if (filters.supplierId) params.set('supplierId', filters.supplierId)
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? DEFAULT_SUPPLY_PRODUCT_FILTERS.pageSize
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const result = params.toString()
  return result ? `?${result}` : ''
}

/**
 * 筛选条件变化时重置到第 1 页，保留其余筛选。
 * 翻页操作不应调用此函数（否则永远停在第 1 页）。
 */
export function resetPageFilters(
  current: SupplyProductFilters,
  changes: Partial<SupplyProductFilters>,
): SupplyProductFilters {
  return { ...current, ...changes, page: 1 }
}

/**
 * 翻页时保留全部筛选条件，只更新 page。
 */
export function keepFiltersForPage(
  current: SupplyProductFilters,
  page: number,
): SupplyProductFilters {
  return { ...current, page }
}

/**
 * 新增商品请求体映射。
 * 过滤空字符串，将数值字段转为 number。
 */
export function buildCreateBody(
  form: {
    name: string
    code: string
    category: string
    unit: string
    price: string
    spec: string
    shelfDays: string
    supplierId?: string
    imageKey?: string | null
  } & Partial<SupplyProductQuantityForm>,
): Record<string, unknown> {
  const shelfDays = form.shelfDays.trim() === '' ? 7 : Number(form.shelfDays)
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    unit: form.unit.trim() || '件',
    price: Number(form.price) || 0,
    shelfDays,
  }
  if (form.code.trim()) body.code = form.code.trim()
  if (form.category.trim()) body.category = form.category.trim()
  if (form.spec.trim()) body.spec = form.spec.trim()
  if (form.supplierId?.trim()) body.supplierId = form.supplierId.trim()
  if (form.imageKey) body.imageKey = form.imageKey

  const stock = parseProductQuantity(form.stock ?? '')
  const minStock = parseProductQuantity(form.minStock ?? '')
  const minOrderQty = parseProductQuantity(form.minOrderQty ?? '')
  const stepQty = parseProductQuantity(form.stepQty ?? '')
  if (stock != null) body.stock = stock
  if (minStock != null) body.minStock = minStock
  if (minOrderQty != null) body.minOrderQty = minOrderQty
  if (stepQty != null) body.stepQty = stepQty

  return body
}

/**
 * 编辑商品请求体映射。只包含实际变更的字段。
 */
function quantityChanged(formValue: string | undefined, originalValue: unknown): boolean {
  if (formValue == null) return false
  const parsed = parseProductQuantity(formValue)
  if (parsed == null) return false
  const original = Number(originalValue ?? 0)
  return parsed !== original
}

export function buildEditBody(
  form: {
    name: string
    code: string
    category: string
    unit: string
    spec: string
    shelfDays: string
  } & Partial<SupplyProductQuantityForm>,
  original: {
    name: string
    code: string
    category: string
    unit: string
    spec: string
    shelfDays: number
    stock?: number | string | null
    minStock?: number | string | null
    minOrderQty?: number | string | null
    stepQty?: number | string | null
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (form.name.trim() !== original.name) body.name = form.name.trim()
  if (form.code.trim() !== original.code) body.code = form.code.trim()
  if (form.category.trim() !== (original.category || '')) body.category = form.category.trim()
  if (form.unit.trim() !== original.unit) body.unit = form.unit.trim()
  if (form.spec.trim() !== (original.spec || '')) body.spec = form.spec.trim() || null
  const shelfDays = form.shelfDays.trim() === '' ? 7 : Number(form.shelfDays)
  if (shelfDays !== original.shelfDays) body.shelfDays = shelfDays

  if (quantityChanged(form.minOrderQty, original.minOrderQty)) {
    body.minOrderQty = parseProductQuantity(form.minOrderQty ?? '')
  }
  if (quantityChanged(form.stepQty, original.stepQty)) body.stepQty = parseProductQuantity(form.stepQty ?? '')

  return body
}

/** 调价请求体。 */
export function buildPriceChangeBody(newPrice: number): { price: number } {
  return { price: newPrice }
}

/** 停售 / 恢复请求体。 */
export function buildStatusChangeBody(next: 'ENABLED' | 'DISABLED'): { status: string } {
  return { status: next }
}

/**
 * 图片 URL 兜底：无有效 URL 时返回 null，由 UI 显示占位符。
 */
export function resolveProductImageUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl || imageUrl.trim() === '') return null
  return imageUrl
}

/** 状态展示文案。 */
export function formatProductStatusLabel(status: string): string {
  const map: Record<string, string> = {
    ENABLED: '供应中',
    DISABLED: '已停售',
    PENDING_APPROVAL: '旧流程待关闭',
    PENDING_DISABLE: '旧流程待关闭',
  }
  return map[status] || status
}

/** 状态 Chip 色调。 */
export function productStatusTone(status: string): 'green' | 'gray' | 'orange' {
  if (status === 'ENABLED') return 'green'
  if (status === 'DISABLED') return 'gray'
  return 'orange'
}

/** 判断筛选条件是否有活跃项（用于"清空"按钮的禁用态）。 */
export function hasActiveFilters(filters: SupplyProductFilters): boolean {
  return Boolean(filters.q.trim() || filters.category || filters.status || filters.supplierId)
}

/** 校验新增商品表单；返回错误文案或 null。 */
export function validateNewProductForm(form: { name: string; price: string }): string | null {
  if (!form.name.trim()) return '商品名称必填'
  const price = Number(form.price)
  if (!Number.isFinite(price) || price < 0) return '单价不能为负数'
  return null
}

/** 金额格式化（人民币）。null / undefined / NaN 返回占位符。 */
export function formatMoney(value: unknown): string {
  if (value == null) return '—'
  const amount = Number(value)
  return Number.isFinite(amount)
    ? `¥${amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—'
}

/** 图片 alt 文本。 */
export function productImageAlt(name: string, code?: string | null): string {
  return code ? `${name} (${code})` : name
}

/** 成本单位价格标签：单价（元 / costUnit）。 */
export function formatCostUnitPriceLabel(costUnit: string): string {
  return `单价（元 / ${costUnit || '成本单位'}）`
}

/** 调价确认文案：包含精确成本单位，可选订货单位折算提示。 */
export function formatPriceChangeConfirmBody(
  oldPrice: number,
  newPrice: number,
  costUnit: string,
  orderUnitHint?: string | null,
): string {
  const lines = [`${formatCostUnitPriceLabel(costUnit)} ${formatMoney(oldPrice)} → ${formatMoney(newPrice)}`]
  if (orderUnitHint) lines.push(orderUnitHint)
  lines.push('')
  lines.push('直接生效并通知总厨。')
  return lines.join('\n')
}
