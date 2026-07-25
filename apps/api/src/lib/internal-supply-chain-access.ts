import { isStoreScoped, requireSupplierBinding } from './auth-scope'

export const INTERNAL_SUPPLY_CHAIN_ROLE = 'SUPPLY_CHAIN'

export const INTERNAL_SUPPLY_CHAIN_READ_CAPABILITIES = [
  'order.read',
  'delivery.read',
  'receipt.read',
  'inventory.read',
  'consumption.read',
] as const

export type InternalSupplyChainReadCapability =
  typeof INTERNAL_SUPPLY_CHAIN_READ_CAPABILITIES[number]

export type InternalSupplyChainCapability =
  | InternalSupplyChainReadCapability
  | 'order.write'
  | 'delivery.write'
  | 'receipt.write'
  | 'inventory.write'
  | 'consumption.write'
  | 'product.approve'
  | 'product.write'
  | 'finance.write'
  | 'store.write'

const INTERNAL_ROLE_CAPABILITIES: Record<string, ReadonlySet<InternalSupplyChainCapability>> = {
  [INTERNAL_SUPPLY_CHAIN_ROLE]: new Set(INTERNAL_SUPPLY_CHAIN_READ_CAPABILITIES),
}

export function isInternalSupplyChainRole(role: string | undefined | null): boolean {
  return role === INTERNAL_SUPPLY_CHAIN_ROLE
}

export function hasInternalSupplyChainCapability(
  role: string | undefined | null,
  capability: InternalSupplyChainCapability,
): boolean {
  if (!role) return false
  return INTERNAL_ROLE_CAPABILITIES[role]?.has(capability) ?? false
}

/**
 * Existing roles keep their route-specific authorization. The internal role
 * must be explicitly granted the requested read capability.
 */
export function allowsSupplyDataRead(
  role: string | undefined | null,
  capability: InternalSupplyChainReadCapability,
): boolean {
  return !isInternalSupplyChainRole(role)
    || hasInternalSupplyChainCapability(role, capability)
}

type SupplyDataReadUser = {
  tenantId: string
  role?: string | null
  storeId?: string | null
  supplierId?: string | null
}

/**
 * Base scope for tenant-owned supply documents.
 *
 * Internal supply-chain users are intentionally tenant-wide. Store roles and
 * external supplier roles remain fail-closed when their required binding is
 * absent, so neither can fall back to a tenant-wide query.
 */
export function supplyDataReadScope(user: SupplyDataReadUser): {
  tenantId: string
  storeId?: string
  supplierId?: string
} {
  const where: { tenantId: string; storeId?: string; supplierId?: string } = {
    tenantId: user.tenantId,
  }
  if (isStoreScoped(user.role)) where.storeId = user.storeId || '__NONE__'
  const supplierId = requireSupplierBinding(user.role, user.supplierId)
  if (supplierId) where.supplierId = supplierId
  return where
}
