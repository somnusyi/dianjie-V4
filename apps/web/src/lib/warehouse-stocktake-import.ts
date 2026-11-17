export type StocktakeImportItem = {
  id: string
  productCodeSnapshot: string
  productNameSnapshot: string
  inventoryUnit: string
  bookQuantity: string
  unitPending?: boolean
}

export type StocktakeImportPreviewRow = {
  rowNo: number
  itemId: string | null
  productCode: string
  productName: string
  inventoryUnit: string
  countedQuantity: string
  reason: string
  error: string | null
}

const quantityPattern = /^\d{1,10}(?:\.\d{1,6})?$/

function cell(row: Record<string, unknown>, aliases: string[]) {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [key.replace(/\s+/g, '').trim(), value])
  )
  for (const alias of aliases) {
    const value = normalized.get(alias)
    if (value !== undefined && value !== null) return String(value).trim()
  }
  return ''
}

function micros(value: string) {
  const match = value.match(/^(\d{1,12})(?:\.(\d{1,6}))?$/)
  if (!match) return null
  return BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] || '').padEnd(6, '0'))
}

export function previewWarehouseStocktakeImportRows(
  rawRows: Array<Record<string, unknown>>,
  items: StocktakeImportItem[]
) {
  const meaningful = rawRows
    .map((row, index) => ({
      row,
      rowNo: index + 2,
      productCode: cell(row, ['物品编码', '商品编码', '编码', 'productCode']),
      countedQuantity: cell(row, ['实盘数量', '盘点数量', 'countedQuantity']),
      inventoryUnit: cell(row, ['库存单位', '单位', 'inventoryUnit']),
      reason: cell(row, ['差异说明', '差异原因', '原因', '备注', 'reason']),
    }))
    .filter(row => row.productCode || row.countedQuantity || row.inventoryUnit || row.reason)

  const codeCounts = new Map<string, number>()
  for (const row of meaningful) codeCounts.set(row.productCode, (codeCounts.get(row.productCode) || 0) + 1)
  const itemByCode = new Map(items.map(item => [item.productCodeSnapshot, item]))
  const rows: StocktakeImportPreviewRow[] = meaningful.map(row => {
    const item = itemByCode.get(row.productCode)
    let error: string | null = null
    if (!row.productCode) error = '物品编码不能为空'
    else if ((codeCounts.get(row.productCode) || 0) > 1) error = '同一物品编码不能重复导入'
    else if (!item) error = '物品编码不在当前盘点分区'
    else if (item.unitPending) error = '该物品库存单位换算待核验'
    else if (!row.countedQuantity) error = '实盘数量不能为空，实盘为零请填写0'
    else if (!quantityPattern.test(row.countedQuantity)) error = '实盘数量格式不正确，最多10位整数及6位小数'
    else if (row.inventoryUnit && row.inventoryUnit !== item.inventoryUnit) error = `库存单位应为${item.inventoryUnit}`
    else if (micros(row.countedQuantity) !== micros(item.bookQuantity) && !row.reason) error = '实盘与账面有差异时必须填写差异说明'
    return {
      rowNo: row.rowNo,
      itemId: item?.id || null,
      productCode: row.productCode,
      productName: item?.productNameSnapshot || '—',
      inventoryUnit: item?.inventoryUnit || row.inventoryUnit,
      countedQuantity: row.countedQuantity,
      reason: row.reason,
      error,
    }
  })
  return {
    rows,
    validCount: rows.filter(row => !row.error).length,
    errorCount: rows.filter(row => row.error).length,
  }
}
