import { isSupplierRole, requireSupplierBinding } from './auth-scope'

export const SUPPLIER_CAPABILITIES = [
  'dashboard.read',
  'order.read',
  'order.accept',
  'order.ship',
  'catalog.read',
  'catalog.manage',
  'inventory.read',
  'inventory.manage',
  'settlement.read',
  'invoice.manage',
  'analytics.read',
] as const

export type SupplierCapability = typeof SUPPLIER_CAPABILITIES[number]

// 当前按业务确认，供应商负责人和员工使用同一套权限。
// 后续拆分订单员、仓管、财务时只调整角色映射，领域路由不再重写判断。
const ROLE_CAPABILITIES: Record<string, ReadonlySet<SupplierCapability>> = {
  SUPPLIER_OWNER: new Set(SUPPLIER_CAPABILITIES),
  SUPPLIER_STAFF: new Set(SUPPLIER_CAPABILITIES),
}

export function supplierCapabilitiesForRole(role: string | undefined | null): ReadonlySet<SupplierCapability> {
  if (!role) return new Set()
  return ROLE_CAPABILITIES[role] || new Set()
}

export function requireSupplierCapability(
  role: string | undefined | null,
  supplierId: string | undefined | null,
  capability: SupplierCapability,
): string {
  if (!isSupplierRole(role)) {
    throw { statusCode: 403, message: '仅供应商账号可访问' }
  }
  const boundSupplierId = requireSupplierBinding(role, supplierId)
  if (!boundSupplierId || !supplierCapabilitiesForRole(role).has(capability)) {
    throw { statusCode: 403, message: '当前供应商岗位无此操作权限' }
  }
  return boundSupplierId
}
