import { storeScopeOf, isSupplierRole } from './auth-scope'

type LossClaimScopeUser = {
  tenantId: string
  role: string
  storeId?: string | null
  storeIds?: string[] | null
  supplierId?: string | null
}

/**
 * LossClaim 查询的统一数据范围。
 *
 * 门店角色只能读取可访问门店集合（多店 storeIds），供应商角色只能读取本供应商；集团角色仍限定在租户内。
 * 列表、详情和打印必须复用同一范围，避免打印链接绕过列表权限。
 */
export function lossClaimScope(user: LossClaimScopeUser) {
  const where: Record<string, any> = { tenantId: user.tenantId }
  const scope = storeScopeOf(user)
  if (scope) where.storeId = scope.length ? { in: scope } : '__NONE__'
  if (isSupplierRole(user.role)) where.supplierId = user.supplierId || '__NONE__'
  return where
}
