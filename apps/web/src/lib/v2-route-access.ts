const MANAGER_ROLES = ['MANAGER', 'PURCHASER'] as const
const SUPPLIER_ROLES = ['SUPPLY_CHAIN', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB'] as const

/**
 * 返回需要限制角色的 v2 业务区。
 *
 * 先覆盖店长与供应商两个高频、数据口径完全不同的工作区，避免同一浏览器
 * 切换账号后出现“店长页面外壳 + 供应商数据”之类的串页。未列出的公共页仍只做
 * 登录校验，由各自现有守卫处理。
 */
export function rolesForV2Path(pathname: string): readonly string[] | undefined {
  if (pathname === '/v2/manager' || pathname.startsWith('/v2/manager/')) {
    return MANAGER_ROLES
  }
  if (pathname === '/v2/supplier' || pathname.startsWith('/v2/supplier/')) {
    return SUPPLIER_ROLES
  }
  return undefined
}
