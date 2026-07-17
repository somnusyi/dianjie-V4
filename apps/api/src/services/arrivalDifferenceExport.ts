export type ArrivalDifferenceExportRow = {
  no: string
  createdAt: Date
  kind: string
  status: string
  payableBasis: string
  totalLossAmount: unknown
  description: string
  store: { name: string }
  purchaseOrder: { no: string } | null
  deliveryOrder: { no: string } | null
  receipt: { no: string } | null
  items: Array<{
    productNameSnapshot?: string | null
    productUnitSnapshot?: string | null
    lossQty: unknown
    lossAmount: unknown
    product?: { name: string; unit: string } | null
  }>
}

function csvCell(value: unknown) {
  let text = String(value ?? '')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function arrivalDifferencesToCsv(rows: ArrivalDifferenceExportRow[]) {
  const header = [
    '差异单号', '创建时间', '门店', '差异类型', '责任状态', '应付基准',
    '订货单', '配送单', '入库单', '涉及金额', '商品明细', '说明',
  ]
  const body = rows.map(row => [
    row.no, row.createdAt.toISOString(), row.store.name, row.kind, row.status, row.payableBasis,
    row.purchaseOrder?.no || '', row.deliveryOrder?.no || '', row.receipt?.no || '',
    Number(row.totalLossAmount || 0).toFixed(2),
    row.items.map(item => {
      const name = item.productNameSnapshot || item.product?.name || '未知商品'
      const unit = item.productUnitSnapshot || item.product?.unit || ''
      return `${name} ${Number(item.lossQty || 0)}${unit} / ¥${Number(item.lossAmount || 0).toFixed(2)}`
    }).join('；'),
    row.description,
  ])
  return `\uFEFF${[header, ...body].map(row => row.map(csvCell).join(',')).join('\r\n')}`
}
