export const SUPPLIER_BUSINESS_SCOPE = {
  WAREHOUSE_UPSTREAM: 'WAREHOUSE_UPSTREAM',
  STORE_FULFILLER: 'STORE_FULFILLER',
  DIRECT_STORE_VENDOR: 'DIRECT_STORE_VENDOR',
} as const

export type SupplierPortalMode = 'UPSTREAM_ONLY' | 'STORE_ONLY' | 'MIXED' | 'UNKNOWN'

/**
 * 供应商门户必须按真实合作关系展示功能，不能把“给总仓供货”和“给门店履约”混成一套待办。
 * UNKNOWN 保留给尚未刷新登录态的历史会话，界面采用兼容模式而不是误隐藏功能。
 */
export function supplierPortalMode(scopes?: readonly string[] | null): SupplierPortalMode {
  if (!scopes?.length) return 'UNKNOWN'
  const upstream = scopes.includes(SUPPLIER_BUSINESS_SCOPE.WAREHOUSE_UPSTREAM)
  const store = scopes.includes(SUPPLIER_BUSINESS_SCOPE.STORE_FULFILLER)
    || scopes.includes(SUPPLIER_BUSINESS_SCOPE.DIRECT_STORE_VENDOR)
  if (upstream && store) return 'MIXED'
  if (upstream) return 'UPSTREAM_ONLY'
  if (store) return 'STORE_ONLY'
  return 'UNKNOWN'
}

export function isUpstreamOnlySupplier(scopes?: readonly string[] | null) {
  return supplierPortalMode(scopes) === 'UPSTREAM_ONLY'
}
