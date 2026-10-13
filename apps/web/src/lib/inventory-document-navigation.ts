const sources = ['purchase-in','purchase-return','other-in','other-out'] as const
export type InventoryDocumentSource = typeof sources[number]
export function inventoryDocumentSource(value: unknown): InventoryDocumentSource | undefined {
  return typeof value==='string' && sources.includes(value as InventoryDocumentSource) ? value as InventoryDocumentSource : undefined
}
export function inventoryDocumentReturnHref(value: unknown, family:'warehouse'|'receipt'|'return'='warehouse') {
  const source=inventoryDocumentSource(value)
  return source ? `/v2/supply-chain/inventory-management/${source}` : family==='warehouse' ? '/v2/supply-chain/docs' : `/v2/supply-chain/procurement?tab=${family==='receipt'?'receipts':'returns'}`
}
export function inventoryDocumentHref(base:string, value?:unknown, action?:string) {
  const params=new URLSearchParams(),source=inventoryDocumentSource(value)
  if(source)params.set('from',source)
  if(action)params.set('action',action)
  return `${base}${params.size?'?'+params:''}`
}
