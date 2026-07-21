/**
 * 角色数据隔离 helper。
 *
 * 门店级角色（MANAGER / CHEF / PURCHASER）应当只看到自己所属 store 的数据。
 * 之前代码里散落着 `role === 'MANAGER'` 当作"是否做 store 过滤"的判断——
 * 漏掉了 CHEF / PURCHASER，于是 chef 看到跨店的采购单 / 入库 / 库存等
 * （Round 4 QA 抓到的 P1 数据泄漏）。
 *
 * 判断角色后仍必须处理未绑定门店的情况；不要把可选 `storeId` 直接交给 Prisma，
 * 否则 `undefined` 会被忽略并退化为租户级查询。需要门店 ID 时使用
 * `requireStoreBinding`。
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

export function requireStoreBinding(
  role: string | undefined | null,
  storeId: string | undefined | null,
): string | undefined {
  if (!isStoreScoped(role)) return undefined
  if (!storeId) {
    throw { statusCode: 403, message: '门店账号未绑定门店，请联系管理员' }
  }
  return storeId
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

/**
 * Supplier-domain requests must fail closed when the account has no supplier
 * binding. Silently omitting the supplier filter turns a supplier request into
 * a tenant-wide query, which is never a safe fallback.
 */
export function requireSupplierBinding(
  role: string | undefined | null,
  supplierId: string | undefined | null,
): string | undefined {
  if (!isSupplierRole(role)) return undefined
  if (!supplierId) {
    throw { statusCode: 403, message: '供应商账号未绑定供应商，请联系管理员' }
  }
  return supplierId
}
