import contract from './report-field-contract.json'

export type InventoryColumn = { key: string; label: string; kind: 'text' | 'number'; group?: string }
export type FinanceColumn = { key: string; label: string; kind?: 'money' | 'quantity' | 'percent' }
export function inventoryColumns(id: string): InventoryColumn[] {
  return contract.find(r => r.id === id)!.columns.map(c => ({ key: c.key, label: c.label, kind: c.kind === 'text' ? 'text' : 'number' }))
}
export function financeColumns(id: string): FinanceColumn[] {
  return contract.find(r => r.id === id)!.columns.map(c => ({ key: c.key, label: c.label, ...(c.kind === 'text' ? {} : { kind: c.kind as FinanceColumn['kind'] }) }))
}
/** Serial numbers describe the filtered/sorted result, and continue across pages. */
export function numberReportRows<T extends Record<string, string | number | null>>(rows: T[], columns: { key: string }[]): T[] {
  return rows.map((row, index) => ({ ...Object.fromEntries(columns.map(c => [c.key, null])), ...row, seq: index + 1 }) as T)
}
