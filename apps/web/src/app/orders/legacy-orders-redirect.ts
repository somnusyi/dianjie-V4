import { routeForRole } from '@/lib/v2-auth'

const SUPPLIER_ROLES = new Set(['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB'])
const MANAGER_ROLES = new Set(['MANAGER', 'SUPERVISOR', 'PURCHASER', 'REGIONAL_MANAGER'])

export function legacyOrdersDestination(role: string | undefined) {
  if (!role) return '/v2/login'
  if (SUPPLIER_ROLES.has(role)) return '/v2/supplier/orders'
  if (role === 'KITCHEN_LEAD') return '/v2/chef/purchase'
  if (role === 'CHEF' || role === 'CHEF_DIRECTOR') return '/v2/chef-director/orders'
  if (MANAGER_ROLES.has(role)) return '/v2/manager/home'
  if (['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(role)) return '/v2/supply-chain/fulfillment'
  return routeForRole(role)
}
