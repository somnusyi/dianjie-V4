export type InventoryExportItem = {
  code: string
  name: string
  productStatus: 'PENDING_APPROVAL' | 'PENDING_DISABLE' | 'ENABLED' | 'DISABLED'
  category?: string | null
  spec?: string | null
  purchaseUnit: string
  inventoryUnit: string
  physicalQty: number
  reservedQty: number
  availableQty: number
  inventoryValue: number
  averageUnitCost: number
  shipmentAmount: number | null
  statusFlag: 'OK' | 'LOW' | 'OUT' | 'SHADOW_GAP'
}

const PRODUCT_STATUS_LABEL: Record<InventoryExportItem['productStatus'], string> = {
  PENDING_APPROVAL: '待启用审核', PENDING_DISABLE: '待停用审核', ENABLED: '启用', DISABLED: '停用',
}

function excelSafe(value: string) {
  return /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value
}

export function buildInventoryExportRows(items: InventoryExportItem[], stockStatus: string) {
  return items.filter(item => !stockStatus || item.statusFlag === stockStatus).map(item => ({
    商品编码: excelSafe(item.code), 商品名称: excelSafe(item.name), 商品状态: PRODUCT_STATUS_LABEL[item.productStatus],
    分类: excelSafe(item.category || ''), 规格: excelSafe(item.spec || ''), 采购单位: excelSafe(item.purchaseUnit), 库存单位: excelSafe(item.inventoryUnit),
    物理库存: item.physicalQty, 预占库存: item.reservedQty, 可用库存: item.availableQty,
    库存金额: item.inventoryValue, 平均单位成本: item.averageUnitCost,
    发货金额: item.shipmentAmount ?? '', 成本金额: item.inventoryValue,
    库存状态: item.statusFlag === 'SHADOW_GAP' ? '待实盘缺口' : item.statusFlag === 'OUT' ? '缺货' : item.statusFlag === 'LOW' ? '偏低' : '正常',
  }))
}
