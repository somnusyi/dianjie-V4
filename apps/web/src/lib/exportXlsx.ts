/**
 * 共享 xlsx 导出 helper (财务报表用)
 *
 * 一个 helper 把 sheets 数组转成 xlsx 文件下载.
 * 跨平台兼容 (Web Share API + a[download] 兜底), 同 supplier/delivery-note 套路.
 *
 * 用法:
 *   await exportXlsx('利润表-2026-05.xlsx', [{
 *     name: '利润表',
 *     rows: [['项目', '金额'], ['营业收入', 1234.56], ...],
 *     cols: [{ wch: 20 }, { wch: 14 }],
 *     merges: [{ s: { r:0, c:0 }, e: { r:0, c:1 }}],
 *     moneyCols: ['B'],   // B 列加 ¥#,##0.00 格式
 *   }])
 */

export interface XlsxSheet {
  name: string
  rows: any[][]
  cols?: Array<{ wch: number }>
  merges?: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>
  /** 列字母 (例 'B', 'C'), 这些列的数据应用 ¥#,##0.00 格式 (header 行除外) */
  moneyCols?: string[]
  /** header 行索引 (默认 0), 用于跳过 header 行不应用 money 格式 */
  headerRowIdx?: number
}

export async function exportXlsx(filename: string, sheets: XlsxSheet[]) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows)
    if (sheet.cols) ws['!cols'] = sheet.cols
    if (sheet.merges) ws['!merges'] = sheet.merges

    // 货币列格式
    if (sheet.moneyCols) {
      const headerRow = sheet.headerRowIdx ?? 0
      const cols: string[] = sheet.moneyCols
      for (let r = headerRow + 1; r < sheet.rows.length; r++) {
        for (const col of cols) {
          const ref = `${col}${r + 1}`
          if (ws[ref] && typeof ws[ref].v === 'number') {
            ws[ref].z = '¥#,##0.00'
          }
        }
      }
    }

    // sheet 名截断 (Excel 限制 31 字符 + 不能含 \\, /, *, ?, [, ])
    const safeName = sheet.name.replace(/[\\/*?[\]]/g, '_').slice(0, 31)
    XLSX.utils.book_append_sheet(wb, ws, safeName)
  }

  const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

  // 移动端 Web Share API 优先
  const file = new File([blob], filename, { type: blob.type })
  const nav = navigator as any
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try { await nav.share({ files: [file], title: filename }); return } catch {}
  }
  // PC fallback: a[download]
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
