/**
 * Operational party fields exposed by purchase and delivery documents.
 *
 * Store and supplier records also contain payment credentials, bank accounts,
 * tax identifiers and finance policy. Document endpoints are used by ordinary
 * store and supplier roles, so they must never return complete party records.
 */
export const supplyDocumentStoreSelect = {
  id: true,
  no: true,
  name: true,
  address: true,
  phone: true,
  managerName: true,
} as const

export const supplyDocumentSupplierSelect = {
  id: true,
  no: true,
  name: true,
  contactName: true,
  contactPhone: true,
  category: true,
  status: true,
} as const
