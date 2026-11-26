type Store = { brandCode: string | null }
type Transfer = {
  brandCode: string | null
  fromStore: Store
  toStore: Store
}

export function visibleStoreTransferBrand(assignedStores: readonly Store[]): string | null {
  if (!assignedStores.length) return null
  const brands = new Set(assignedStores.map(store => store.brandCode))
  if (brands.size !== 1) return null
  return assignedStores[0].brandCode
}

/** Historical transfers without a snapshot never enter a store-side response. */
export function transferMatchesCurrentBrand(transfer: Transfer, brandCode: string): boolean {
  return transfer.brandCode === brandCode
    && transfer.fromStore.brandCode === brandCode
    && transfer.toStore.brandCode === brandCode
}
