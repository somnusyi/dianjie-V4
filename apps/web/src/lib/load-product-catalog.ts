import { apiFetch } from '@/lib/v2-auth'
import type { RevisionCatalogProduct } from '@/lib/supplier-revision-cost-pricing'

const PAGE_SIZE = 100
const MAX_PAGES = 100

type WarehouseInventoryProduct = {
  id?: unknown
}

/** Load every catalog page; callers may still filter status for their workflow. */
export async function loadAllProductCatalog(supplierId?: string | null): Promise<RevisionCatalogProduct[]> {
  const products = new Map<string, RevisionCatalogProduct>()

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const supplierQuery = supplierId ? `supplierId=${encodeURIComponent(supplierId)}&` : ''
    const response = await apiFetch<any>(`/api/products?${supplierQuery}page=${page}&pageSize=${PAGE_SIZE}`)
    const items = (Array.isArray(response) ? response : response?.items || []) as RevisionCatalogProduct[]
    for (const item of items) products.set(item.id, item)

    if (Array.isArray(response) || items.length === 0) break
    const total = Number(response?.total)
    if ((Number.isFinite(total) && products.size >= total) || items.length < PAGE_SIZE) break
  }

  return [...products.values()]
}

/**
 * Load products that belong to both the selected supplier catalog and the
 * default warehouse's stock scope. Warehouse loading is deliberately first:
 * an unavailable warehouse endpoint must fail closed instead of exposing the
 * supplier's full catalog as a fallback.
 */
export async function loadAllWarehouseProductCatalog(
  supplierId?: string | null,
): Promise<RevisionCatalogProduct[]> {
  const warehouseProductIds = new Set<string>()

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await apiFetch<any>(
      `/api/warehouse-inventory?scope=stock&page=${page}&pageSize=${PAGE_SIZE}`,
    )
    const items = (Array.isArray(response) ? response : response?.items || []) as WarehouseInventoryProduct[]
    for (const item of items) {
      if (typeof item?.id === 'string' && item.id) warehouseProductIds.add(item.id)
    }

    if (Array.isArray(response) || items.length === 0) break
    const totalPages = Number(response?.totalPages)
    if (Number.isFinite(totalPages) && page >= totalPages) break
    const total = Number(response?.total)
    if ((Number.isFinite(total) && page * PAGE_SIZE >= total) || items.length < PAGE_SIZE) break
  }

  if (warehouseProductIds.size === 0) return []

  const supplierProducts = await loadAllProductCatalog(supplierId)
  return supplierProducts.filter(product => warehouseProductIds.has(product.id))
}
