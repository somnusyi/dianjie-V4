'use client'

import { useCallback, useEffect, useState, type SetStateAction } from 'react'
import { getUser } from './v2-auth'
import { DEFAULT_SUPPLY_PRODUCT_FILTERS, type SupplyProductFilters } from './supply-product-pc'

export const internalProductDefaultFilters = (): SupplyProductFilters => ({ ...DEFAULT_SUPPLY_PRODUCT_FILTERS, status: 'ENABLED' })

function ownerKey() {
  const user = getUser()
  return user?.id && user.tenantId ? `dj:supply-product-filters:v1:${user.tenantId}:${user.id}` : ''
}

function read(key: string): SupplyProductFilters {
  const fallback = internalProductDefaultFilters()
  try {
    if (!key) return fallback
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return fallback
    const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : ''
    return {
      q: text(saved.q, 500), category: text(saved.category, 200), supplierId: text(saved.supplierId, 128),
      status: ['', 'ENABLED', 'DISABLED', 'PENDING_APPROVAL', 'PENDING_DISABLE'].includes(saved.status) ? saved.status : fallback.status,
      page: Number.isInteger(saved.page) && saved.page > 0 && saved.page <= 100000 ? saved.page : fallback.page,
      pageSize: [20, 50, 100, 200, 500, 1000, 2000].includes(saved.pageSize) ? saved.pageSize : fallback.pageSize,
    }
  } catch { return fallback }
}

/** Restore before querying; save only filters and only for the current account in this tab. */
export function useSupplyProductFilters() {
  const key = ownerKey()
  const [state, setState] = useState<{ key: string | null; filters: SupplyProductFilters }>({ key: null, filters: internalProductDefaultFilters() })
  useEffect(() => { setState({ key, filters: read(key) }) }, [key])
  const setFilters = useCallback((next: SetStateAction<SupplyProductFilters>) => {
    if (ownerKey() !== key) return
    setState(current => {
      if (ownerKey() !== key) return current
      const previous = current.key === key ? current.filters : internalProductDefaultFilters()
      const filters = typeof next === 'function' ? next(previous) : next
      if (key && ownerKey() === key) {
        try { sessionStorage.setItem(key, JSON.stringify(filters)) } catch { /* Filtering remains usable without browser storage. */ }
      }
      return { key, filters }
    })
  }, [key])
  return [state.key === key ? state.filters : internalProductDefaultFilters(), setFilters, state.key === key] as const
}
