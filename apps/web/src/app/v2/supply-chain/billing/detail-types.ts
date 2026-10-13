/**
 * DJ-002 / REQ-FIN-001 / DEC-023：账务三类只读详情的共享返回类型。
 * 金额字段沿用后端 Decimal 序列化结果（string 或 number），前端只展示、不重算历史金额。
 */

export type BillingDetailType = 'schedule' | 'reconciliation' | 'invoice'

/** GET /api/schedules/:id */
export type ScheduleDetail = {
  id: string
  amount: number | string
  status: string
  dueAt: string
  paidAt?: string | null
  supplier?: { id: string; name: string }
  receipt?: {
    id: string
    no: string
    deliveryDate: string
    totalAmount: number | string
    store?: { id: string; name: string }
  } | null
}

/** GET /api/reconciliations/:id 的组成行 */
export type ReconciliationDetailItem = {
  receiptId: string
  amount: number | string
  receipt: {
    id: string
    no: string
    deliveryDate: string
    totalAmount: number | string
  } | null
}

/** GET /api/reconciliations/:id */
export type ReconciliationDetail = {
  id: string
  no: string
  periodStart: string
  periodEnd: string
  status: string
  totalAmount: number | string
  supplier?: { id: string; name: string; no?: string }
  items: ReconciliationDetailItem[]
}

/** GET /api/invoices/:id（既有接口）中前端获准呈现的票面字段 */
export type InvoiceDetail = {
  id: string
  invoiceNo: string
  invoiceCode?: string | null
  amount: number | string
  amountWithoutTax?: number | string | null
  taxRate?: number | string | null
  taxAmount?: number | string | null
  issueDate: string
  status: string
  note?: string | null
  fileUrl?: string
  fileType?: string
  supplier?: { id: string; name: string }
  receipts?: Array<{
    id: string
    no: string
    deliveryDate: string
    totalAmount: number | string
    store?: { name?: string }
  }>
}

/** GET /api/receipts/:id（既有接口）来源入库商品明细中使用的字段 */
export type ReceiptSourceDetail = {
  id: string
  no: string
  deliveryDate?: string
  status?: string
  totalAmount?: number | string
  store?: { name?: string }
  supplier?: { name?: string }
  items?: Array<{
    id: string
    quantity: number | string
    unitPrice: number | string
    amount: number | string
    productCodeSnapshot?: string | null
    productNameSnapshot?: string | null
    productSpecSnapshot?: string | null
    productUnitSnapshot?: string | null
    product?: {
      code?: string
      name?: string
      spec?: string | null
      unit?: string
    }
  }>
}

/** 详情弹窗目标；titleHint 仅来自列表行，用于加载中的标题标识，不冒充服务器完整内容 */
export type BillingDetailTarget = {
  type: BillingDetailType
  id: string
  titleHint?: string
}
