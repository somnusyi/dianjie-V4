import type { SupplierFormValues } from './supply-supplier-pc'
import type { BindItemDraft } from './supply-relations'

export const SUPPLIER_CREATE_PENDING_PREFIX = 'dj:supplier-create:'
export type PendingSupplierCreate = {
  requestKey: string; numberMode?: 'AUTO' | 'MANUAL'; supplier: Record<string, unknown>; items: BindItemDraft[]; formValues: SupplierFormValues
}
function storageKey(): string {
  const user = JSON.parse(localStorage.getItem('user') || localStorage.getItem('dj_user') || 'null')
  const tenant = JSON.parse(localStorage.getItem('tenant') || 'null')
  if (!user?.id || !tenant?.id) throw new Error('缺少当前账号或租户信息，请重新登录后创建')
  return `${SUPPLIER_CREATE_PENDING_PREFIX}${tenant.id}:${user.id}`
}
export function readPendingSupplierCreate(): PendingSupplierCreate | null {
  const raw = localStorage.getItem(storageKey())
  if (!raw) return null
  const value = JSON.parse(raw)
  if (!value.requestKey || !value.supplier || !value.formValues || !Array.isArray(value.items) || !value.items.length) throw new Error('上次创建请求记录损坏，请核实创建结果后处理')
  return value
}
export function savePendingSupplierCreate(value: PendingSupplierCreate) { localStorage.setItem(storageKey(), JSON.stringify(value)) }
export function clearPendingSupplierCreate() { localStorage.removeItem(storageKey()) }
