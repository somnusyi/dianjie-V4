import contract from '../../../api/src/services/inventory-management-contract.json'

export const managementPages = contract
export type ManagementPage = typeof contract[number]
export type ManagementGroup = 'inventory' | 'stocktake'
export const managementGroupLabel = (group: ManagementGroup) => group === 'inventory' ? '库存管理' : '盘点管理'
export const managementHref = (page: ManagementPage) => `/v2/supply-chain/${page.group === 'inventory' ? 'inventory-management' : 'stocktake'}/${page.id}`
export type ManagementRow = Record<string, string | number | null>
export type ManagementResult = {
  id: string; rows: ManagementRow[]; total: number; totals?: Record<string, number>; page: number; pageSize: number
  note: string; sourceAvailable: boolean; supportedFilters: string[]; options: Record<string, string[]>
}
