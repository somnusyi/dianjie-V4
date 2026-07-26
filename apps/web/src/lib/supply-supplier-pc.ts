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

export const SUPPLIER_CREDIT_TYPE_OPTIONS = [
  { value: 'FIXED_DAYS', label: '固定天数' },
  { value: 'MONTHLY', label: '月结' },
  { value: 'WEEKLY', label: '周结' },
  { value: 'ON_DELIVERY', label: '货到付款' },
] as const

export type SupplierCreditType = (typeof SUPPLIER_CREDIT_TYPE_OPTIONS)[number]['value']

/**
 * 供应商新增 / 编辑抽屉的表单值。
 *
 * 只包含编号、名称、联系人、联系电话、类目、账期类型、账期天数。
 * 不收集银行账号、自动付款、付款审批、邀请外部供应商等字段。
 */
export type SupplierFormValues = {
  no: string
  name: string
  contactName: string
  contactPhone: string
  category: string
  creditType: SupplierCreditType
  creditDays: string
}

export const EMPTY_SUPPLIER_FORM_VALUES: SupplierFormValues = {
  no: '',
  name: '',
  contactName: '',
  contactPhone: '',
  category: '',
  creditType: 'FIXED_DAYS',
  creditDays: '30',
}

/**
 * 用现有供应商数据初始化表单（编辑场景）。
 */
export function initializeSupplierFormValues(supplier?: SupplySupplier | null): SupplierFormValues {
  if (!supplier) return EMPTY_SUPPLIER_FORM_VALUES
  return {
    no: supplier.no ?? '',
    name: supplier.name ?? '',
    contactName: supplier.contactName ?? '',
    contactPhone: supplier.contactPhone ?? '',
    category: supplier.category ?? '',
    creditType: (supplier.creditType as SupplierCreditType) || 'FIXED_DAYS',
    creditDays: supplier.creditDays != null ? String(supplier.creditDays) : '30',
  }
}

/**
 * 账期类型 → 展示文案。
 */
export function formatSupplierCreditTypeLabel(creditType?: string | null): string {
  return SUPPLIER_CREDIT_TYPE_OPTIONS.find(opt => opt.value === creditType)?.label ?? (creditType || '—')
}

export type SupplierFormErrors = Partial<Record<keyof SupplierFormValues, string>>

/**
 * 表单校验。规则严格对齐 API 输入边界：
 *
 * - 编号 / 名称必填
 * - 编号 ≤ 40，名称 ≤ 80，联系人 ≤ 40，电话 ≤ 20，类目 ≤ 40
 * - 账期类型必填
 * - 固定天数账期：必填，整数，0–365
 */
export function validateSupplierForm(values: SupplierFormValues): SupplierFormErrors {
  const errors: SupplierFormErrors = {}

  const no = values.no.trim()
  if (!no) errors.no = '请输入供应商编号'
  else if (no.length > 40) errors.no = '编号最多 40 个字符'

  const name = values.name.trim()
  if (!name) errors.name = '请输入供应商名称'
  else if (name.length > 80) errors.name = '名称最多 80 个字符'

  if (values.contactName.trim().length > 40) errors.contactName = '联系人最多 40 个字符'
  if (values.contactPhone.trim().length > 20) errors.contactPhone = '联系电话最多 20 个字符'
  if (values.category.trim().length > 40) errors.category = '类目最多 40 个字符'

  if (!SUPPLIER_CREDIT_TYPE_OPTIONS.some(opt => opt.value === values.creditType)) {
    errors.creditType = '请选择账期类型'
  }

  if (values.creditType === 'FIXED_DAYS') {
    const rawDays = values.creditDays.trim()
    if (rawDays === '') {
      errors.creditDays = '请输入账期天数'
    } else if (!/^\d+$/.test(rawDays)) {
      errors.creditDays = '账期天数必须是整数'
    } else {
      const days = Number(rawDays)
      if (days < 0 || days > 365) errors.creditDays = '账期天数必须在 0–365 之间'
    }
  }

  return errors
}

/**
 * 构建 POST /api/suppliers 请求体。
 * 输出字段仅限允许范围，不会带入银行账号、自动付款等敏感字段。
 */
export function buildSupplierCreatePayload(values: SupplierFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    no: values.no.trim(),
    name: values.name.trim(),
    contactName: values.contactName.trim(),
    contactPhone: values.contactPhone.trim(),
    category: values.category.trim(),
    creditType: values.creditType,
  }
  if (values.creditType === 'FIXED_DAYS') {
    payload.creditDays = Number(values.creditDays.trim())
  }
  return payload
}

/**
 * 构建 PATCH /api/suppliers/:id 请求体。
 * 编辑场景编号只读，不提交；其余字段与新增一致。
 */
export function buildSupplierUpdatePayload(values: SupplierFormValues): Record<string, unknown> {
  const payload = buildSupplierCreatePayload(values)
  delete payload.no
  return payload
}
