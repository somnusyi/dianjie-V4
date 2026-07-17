export type SupplierStatementSourceRow = {
  id: string
  no: string
  deliveryDate: Date
  totalAmount: unknown
  store: { id: string; name: string }
  purchaseOrder: {
    id: string
    no: string
    totalAmount: unknown
    currentOrderAmount: unknown | null
  } | null
  deliveryOrder: { id: string; no: string; actualTotalAmount: unknown } | null
  paymentSchedule: {
    id: string
    amount: unknown
    status: string
    dueAt: Date
    paidAt: Date | null
    bankTxNo: string | null
  } | null
  lossClaims: Array<{
    id: string
    no: string
    kind: string
    status: string
    payableBasis: string
    totalLossAmount: unknown
    resolvedDeductAmount: unknown | null
  }>
}

function amount(value: unknown) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function money(value: number) {
  return Number(value.toFixed(2))
}

function csvCell(value: unknown) {
  let text = String(value ?? '')
  // Prevent spreadsheet formula execution when supplier/store/document text is opened in Excel.
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * Read projection for supplier monthly reconciliation.
 * It deliberately does not mutate the legacy one-receipt reconciliation/payment workflow.
 */
export function buildSupplierStatement(rows: SupplierStatementSourceRow[]) {
  const orderedPurchaseOrders = new Map<string, number>()
  const lines = rows.map(row => {
    if (row.purchaseOrder && !orderedPurchaseOrders.has(row.purchaseOrder.id)) {
      orderedPurchaseOrders.set(
        row.purchaseOrder.id,
        amount(row.purchaseOrder.currentOrderAmount ?? row.purchaseOrder.totalAmount),
      )
    }
    const receivedAmount = amount(row.totalAmount)
    const payableAmount = row.paymentSchedule ? amount(row.paymentSchedule.amount) : null
    const differenceAmount = row.lossClaims.reduce((sum, claim) => sum + amount(claim.totalLossAmount), 0)
    return {
      receiptId: row.id,
      receiptNo: row.no,
      deliveryDate: row.deliveryDate,
      store: row.store,
      purchaseOrder: row.purchaseOrder ? { id: row.purchaseOrder.id, no: row.purchaseOrder.no } : null,
      deliveryOrder: row.deliveryOrder ? { id: row.deliveryOrder.id, no: row.deliveryOrder.no } : null,
      orderedAmount: row.purchaseOrder
        ? money(amount(row.purchaseOrder.currentOrderAmount ?? row.purchaseOrder.totalAmount))
        : null,
      shipmentAmount: row.deliveryOrder ? money(amount(row.deliveryOrder.actualTotalAmount)) : null,
      receivedAmount: money(receivedAmount),
      payableAmount: payableAmount == null ? null : money(payableAmount),
      payableAdjustment: payableAmount == null ? null : money(receivedAmount - payableAmount),
      schedule: row.paymentSchedule ? {
        id: row.paymentSchedule.id,
        status: row.paymentSchedule.status,
        dueAt: row.paymentSchedule.dueAt,
        paidAt: row.paymentSchedule.paidAt,
        bankTxNo: row.paymentSchedule.bankTxNo,
      } : null,
      differences: row.lossClaims.map(claim => ({
        id: claim.id,
        no: claim.no,
        kind: claim.kind,
        status: claim.status,
        payableBasis: claim.payableBasis,
        amount: money(amount(claim.totalLossAmount)),
        resolvedDeductAmount: claim.resolvedDeductAmount == null ? null : money(amount(claim.resolvedDeductAmount)),
      })),
      differenceAmount: money(differenceAmount),
    }
  })

  return {
    summary: {
      receiptCount: rows.length,
      purchaseOrderCount: orderedPurchaseOrders.size,
      orderedAmount: money([...orderedPurchaseOrders.values()].reduce((sum, value) => sum + value, 0)),
      shipmentAmount: money(lines.reduce((sum, line) => sum + (line.shipmentAmount || 0), 0)),
      receivedAmount: money(lines.reduce((sum, line) => sum + line.receivedAmount, 0)),
      payableAmount: money(lines.reduce((sum, line) => sum + (line.payableAmount || 0), 0)),
      payableAdjustment: money(lines.reduce((sum, line) => sum + (line.payableAdjustment || 0), 0)),
      differenceCount: lines.reduce((sum, line) => sum + line.differences.length, 0),
      differenceAmount: money(lines.reduce((sum, line) => sum + line.differenceAmount, 0)),
      missingScheduleCount: lines.filter(line => !line.schedule).length,
      onHoldCount: lines.filter(line => line.schedule?.status === 'ON_HOLD').length,
    },
    lines,
  }
}

export function supplierStatementToCsv(statement: ReturnType<typeof buildSupplierStatement>) {
  const header = [
    '到货日期', '门店', '订货单', '配送单', '入库单',
    '订货金额', '实发金额', '实收金额', '应付金额', '应付调整',
    '付款状态', '到期日', '差异笔数', '差异涉及金额', '差异单号',
  ]
  const rows = statement.lines.map(line => [
    line.deliveryDate.toISOString().slice(0, 10), line.store.name,
    line.purchaseOrder?.no || '', line.deliveryOrder?.no || '', line.receiptNo,
    line.orderedAmount ?? '', line.shipmentAmount ?? '', line.receivedAmount,
    line.payableAmount ?? '', line.payableAdjustment ?? '',
    line.schedule?.status || 'MISSING', line.schedule?.dueAt.toISOString().slice(0, 10) || '',
    line.differences.length, line.differenceAmount, line.differences.map(item => item.no).join('、'),
  ])
  return `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}`
}
