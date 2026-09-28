'use client'

export type ReportCell = string | number | null | undefined
export type TableReport = { title: string; subtitle?: string; headers: string[]; rows: ReportCell[][] }

let report: TableReport | null = null
const listeners = new Set<() => void>()

export function showTableReport(value: TableReport | null) {
  report = value
  listeners.forEach(listener => listener())
}

export const subscribeTableReport = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getTableReport = () => report
export const getServerTableReport = () => null

export function reportCsv(value: TableReport) {
  const cell = (value: ReportCell) => {
    let text = String(value ?? '')
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  return '\uFEFF' + [value.headers, ...value.rows].map(row => row.map(cell).join(',')).join('\r\n')
}

export async function downloadTableReport(value: TableReport, format: 'xlsx' | 'csv' = 'xlsx') {
  if (format === 'csv') {
    const url = URL.createObjectURL(new Blob([reportCsv(value)], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${value.title}.csv`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet([value.headers, ...value.rows])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, '单据明细')
  if (value.subtitle) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[value.title], [value.subtitle]]), '说明')
  XLSX.writeFile(book, `${value.title}.xlsx`)
}

/** Retrieve every matching page; never silently print/export only the visible page or a partial result. */
export async function collectReportPages<T>(loader: (page: number, pageSize: number) => Promise<{ items: T[]; total: number }>, limit = 10000): Promise<T[]> {
  const rows: T[] = []
  let expected: number | null = null
  const pageSize = 100
  for (let page = 1; ; page++) {
    const result = await loader(page, pageSize)
    if (!Number.isInteger(result.total) || result.total < 0 || !Array.isArray(result.items)) throw new Error('打印响应无效，请重试')
    if (result.total > limit) throw new Error(`结果超过${limit}条，请缩小筛选范围再打印`)
    if (expected != null && expected !== result.total) throw new Error('准备打印期间记录已变化，请重新查询后重试')
    expected = result.total
    if (!result.items.length && rows.length < expected) throw new Error('打印数据不完整，请重新查询后重试')
    rows.push(...result.items)
    if (rows.length >= expected) {
      if (rows.length !== expected) throw new Error('准备打印期间记录已变化，请重试')
      return rows
    }
  }
}
