const MANAGER_ROLES = ['MANAGER', 'PURCHASER'] as const
const SUPPLIER_ROLES = ['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB'] as const
const INTERNAL_SUPPLY_CHAIN_ROLES = ['SUPPLY_CHAIN'] as const

/**
 * 返回需要限制角色的 v2 业务区。
 *
 * 先覆盖店长与供应商两个高频、数据口径完全不同的工作区，避免同一浏览器
 * 切换账号后出现“店长页面外壳 + 供应商数据”之类的串页。未列出的公共页仍只做
 * 登录校验，由各自现有守卫处理。
 */
export function rolesForV2Path(pathname: string): readonly string[] | undefined {
  if (pathname === '/v2/supply-chain' || pathname.startsWith('/v2/supply-chain/')) {
    return INTERNAL_SUPPLY_CHAIN_ROLES
  }
  if (pathname === '/v2/manager' || pathname.startsWith('/v2/manager/')) {
    return MANAGER_ROLES
  }
  if (pathname === '/v2/supplier' || pathname.startsWith('/v2/supplier/')) {
    return SUPPLIER_ROLES
  }
  return undefined
}

/**
 * 内部供应链使用独立工作区。跨店履约数据保持只读，商品主数据写操作只在
 * `/v2/supply-chain` 域内开放；即使页面忘记声明 requireRole，这里仍拒绝
 * 供应商、财务、销售分析和门店写操作页面。
 */
export function isV2PathAllowedForRole(pathname: string, role: string): boolean {
  if (role !== 'SUPPLY_CHAIN') return true
  if (pathname === '/v2/me' || pathname === '/v2/me/password') return true
  // 反馈是所有已登录员工的共享能力；否则全局反馈按钮对供应链角色会形成死链接。
  if (pathname === '/v2/feedback' || pathname.startsWith('/v2/feedback/')) return true
  return pathname === '/v2/supply-chain' || pathname.startsWith('/v2/supply-chain/')
}
