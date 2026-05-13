/**
 * 角色数据隔离 helper。
 *
 * 门店级角色（MANAGER / CHEF / PURCHASER）应当只看到自己所属 store 的数据。
 * 之前代码里散落着 `role === 'MANAGER'` 当作"是否做 store 过滤"的判断——
 * 漏掉了 CHEF / PURCHASER，于是 chef 看到跨店的采购单 / 入库 / 库存等
 * （Round 4 QA 抓到的 P1 数据泄漏）。
 *
 * 用法：`if (storeId && isStoreScoped(role)) where.storeId = storeId`
 */

const STORE_SCOPED_ROLES = new Set([
  'MANAGER',
  'CHEF',           // legacy 旧角色名
  'PURCHASER',      // legacy
  'KITCHEN_LEAD',   // v2 厨师长 (单店级)
])

export function isStoreScoped(role: string | undefined | null): boolean {
  if (!role) return false
  return STORE_SCOPED_ROLES.has(role)
}

/**
 * 供应商角色统一识别 (业主 / 员工 / 子账号)
 * 凡是供应商域账号都按 supplierId 过滤数据
 */
const SUPPLIER_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB'])
export function isSupplierRole(role: string | undefined | null): boolean {
  if (!role) return false
  return SUPPLIER_ROLES.has(role)
}
