type SnapshotItem = {
  product?: Record<string, unknown> | null
  productCodeSnapshot?: string | null
  productNameSnapshot?: string | null
  productSpecSnapshot?: string | null
  productUnitSnapshot?: string | null
  productCategorySnapshot?: string | null
}

/**
 * Historical supply documents must render the frozen item wording, not today's
 * mutable product master. Legacy rows fall back to the current product relation.
 */
export function withDocumentProductSnapshot<T extends SnapshotItem>(item: T) {
  const current = item.product || {}
  return {
    ...item,
    product: {
      ...current,
      code: item.productCodeSnapshot ?? current.code ?? '',
      name: item.productNameSnapshot ?? current.name ?? '',
      spec: item.productSpecSnapshot ?? current.spec ?? null,
      unit: item.productUnitSnapshot ?? current.unit ?? '',
      category: item.productCategorySnapshot ?? current.category ?? '',
    },
  }
}
