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
  'SUPERVISOR',     // 主管 (同店长机制, 允许多店)
  'REGIONAL_MANAGER', // 区域经理 (指派门店集合, 机制同店长)
])

export function isStoreScoped(role: string | undefined | null): boolean {
  if (!role) return false
  return STORE_SCOPED_ROLES.has(role)
}

// ── 多店数据范围（方案 C 第一阶段：岗位定权限 × storeIds 定范围）──────────
// user 形状兼容 JWT payload 与 User 表记录：storeIds 优先，空则回退 storeId 单店
type StoreScopedUser = {
  role?: string | null
  storeId?: string | null
  storeIds?: string[] | null
}

/**
 * 返回门店级角色的可访问门店集合；非门店级角色返回 null（= 租户级，不过滤）。
 * 空数组 = 门店级角色但未绑定任何门店，调用方必须 fail-closed。
 */
export function storeScopeOf(user: StoreScopedUser): string[] | null {
  if (!isStoreScoped(user.role)) return null
  const ids = (user.storeIds && user.storeIds.length > 0)
    ? user.storeIds
    : (user.storeId ? [user.storeId] : [])
  return [...new Set(ids)]
}

/**
 * 解析本次请求的活动门店：
 * - 非门店级角色：原样返回请求的 storeId（可能 undefined），不做限制
 * - 门店级角色：请求指定的店必须在可访问集合内，否则抛 403；
 *   未指定时默认集合第一家；集合为空返回 undefined（调用方配 `|| '__NONE__'` 保持 fail-closed）
 */
export function resolveActiveStore(
  user: StoreScopedUser,
  requestedStoreId?: string | null,
): string | undefined {
  const scope = storeScopeOf(user)
  if (scope === null) return requestedStoreId ?? undefined
  if (requestedStoreId) {
    if (!scope.includes(requestedStoreId)) {
      throw { statusCode: 403, message: '无权限访问该门店' }
    }
    return requestedStoreId
  }
  return scope[0]
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
