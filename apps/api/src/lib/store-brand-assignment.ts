// Keep this in step with the store-scoped roles in auth-scope.ts.
const STORE_BRAND_ROLES = new Set([
  'MANAGER', 'KITCHEN_LEAD', 'CHEF', 'PURCHASER',
  'SUPERVISOR', 'REGIONAL_MANAGER', 'STAFF',
])

export function isStoreBrandRole(role: string): boolean {
  return STORE_BRAND_ROLES.has(role)
}

/** Null is a distinct legacy group: it cannot be combined with a confirmed brand. */
export function isSingleBrandAssignment(stores: readonly { brandCode: string | null }[]): boolean {
  return new Set(stores.map(store => store.brandCode)).size <= 1
}

export function isValidStoreBrandAssignment(
  role: string,
  stores: readonly { brandCode: string | null }[],
): boolean {
  return !isStoreBrandRole(role) || isSingleBrandAssignment(stores)
}
