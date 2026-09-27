export type BillingCsvTab = 'schedule' | 'reconciliation' | 'invoice'

type ScheduleCsvRow = {
  amount: number | string
  status: string
  dueAt: string
  supplier?: { name: string }
  receipt?: { no: string; store?: { name: string } }
}

type ReconciliationCsvRow = {
  no: string
  totalAmount: number | string
  status: string
  periodStart: string
  periodEnd: string
  supplier?: { name: string; no?: string }
}

type InvoiceCsvRow = {
  invoiceNo: string
  amount: number | string
  status: string
  issueDate: string
  supplier?: { name: string }
  receipts?: Array<{ id: string }>
}

export type BillingCsvRows = {
  schedule: ScheduleCsvRow[]
  reconciliation: ReconciliationCsvRow[]
  invoice: InvoiceCsvRow[]
}

const TAB_LABEL: Record<BillingCsvTab, string> = {
  schedule: '账期',
  reconciliation: '对账单',
  invoice: '发票',
}

function csvCell(value: unknown) {
  const raw = value == null ? '' : String(value)
  const text = typeof value === 'string' && /^[=+\-@\t]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function day(value?: string | null) {
  return value?.slice(0, 10) || ''
}

export function buildBillingCsv<T extends BillingCsvTab>(tab: T, rows: BillingCsvRows[T]) {
  let matrix: unknown[][]
  if (tab === 'schedule') {
    matrix = [
      ['供应商', '入库单', '门店', '到期日', '状态', '金额'],
      ...(rows as ScheduleCsvRow[]).map(item => [
        item.supplier?.name || '', item.receipt?.no || '', item.receipt?.store?.name || '',
        day(item.dueAt), item.status, Number(item.amount || 0),
      ]),
    ]
  } else if (tab === 'reconciliation') {
    matrix = [
      ['对账单号', '供应商', '供应商编号', '期间开始', '期间结束', '状态', '金额'],
      ...(rows as ReconciliationCsvRow[]).map(item => [
        item.no, item.supplier?.name || '', item.supplier?.no || '', day(item.periodStart),
        day(item.periodEnd), item.status, Number(item.totalAmount || 0),
      ]),
    ]
  } else {
    matrix = [
      ['发票号码', '供应商', '开票日', '关联入库数', '状态', '金额'],
      ...(rows as InvoiceCsvRow[]).map(item => [
        item.invoiceNo, item.supplier?.name || '', day(item.issueDate), item.receipts?.length || 0,
        item.status, Number(item.amount || 0),
      ]),
    ]
  }
  return `\ufeff${matrix.map(row => row.map(csvCell).join(',')).join('\r\n')}`
}

export function billingCsvFilename(tab: BillingCsvTab, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `供应链账务-${TAB_LABEL[tab]}-${stamp}.csv`
}

export function downloadBillingCsv<T extends BillingCsvTab>(tab: T, rows: BillingCsvRows[T]) {
  const url = URL.createObjectURL(new Blob([buildBillingCsv(tab, rows)], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = billingCsvFilename(tab)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
}
