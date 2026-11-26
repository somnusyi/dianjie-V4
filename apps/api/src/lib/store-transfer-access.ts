import { storeScopeOf } from './auth-scope'

type Actor = { role: string; storeId?: string | null; storeIds?: string[] | null }
type TransferStores = { fromStoreId: string; toStoreId: string }

export const TRANSFER_REVIEW_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])
export const TRANSFER_CREATE_ROLES = new Set(['MANAGER'])

export function canViewTransfer(actor: Actor, transfer: TransferStores): boolean {
  if (TRANSFER_REVIEW_ROLES.has(actor.role) || actor.role === 'FINANCE') return true
  const stores = storeScopeOf(actor)
  return stores !== null && (stores.includes(transfer.fromStoreId) || stores.includes(transfer.toStoreId))
}

export function canCreateTransfer(actor: Actor, fromStoreId: string): boolean {
  return TRANSFER_CREATE_ROLES.has(actor.role) && (storeScopeOf(actor) ?? []).includes(fromStoreId)
}

export function sameConfirmedBrand(from: { brandCode: string | null }, to: { brandCode: string | null }): boolean {
  return !!from.brandCode && from.brandCode === to.brandCode
}

export function isTransferStoreActor(actor: Actor): boolean {
  return actor.role === 'MANAGER'
}
