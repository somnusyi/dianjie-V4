import { apiFetch } from '@/lib/v2-auth'
import type { RevisionCatalogProduct } from '@/lib/supplier-revision-cost-pricing'

const PAGE_SIZE = 100
const MAX_PAGES = 100

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
