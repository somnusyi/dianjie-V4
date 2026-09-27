export const SUPPLIER_DIFFERENCES_PATH = '/v2/supplier/differences'

export function supplierOrdersLegacyDifferenceRedirect(search: string) {
  const filter = new URLSearchParams(search).get('filter')
  return filter === '报损' || filter === '到货差异' ? SUPPLIER_DIFFERENCES_PATH : null
}
