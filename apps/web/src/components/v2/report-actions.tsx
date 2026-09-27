'use client'
import { useRef, useState, useSyncExternalStore } from 'react'
import { collectReportPages, downloadTableReport, getServerTableReport, getTableReport, showTableReport, subscribeTableReport, type TableReport } from '@/lib/table-report'
import { notifyUser } from '@/lib/ui-dialogs'
export { collectReportPages }
export function ReportActions({ loadReport, csv = false, printOnly = false, disabled = false }: { loadReport: () => TableReport | Promise<TableReport>; csv?: boolean; printOnly?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  async function perform(print: boolean) {
    if (working.current) return
    working.current = true; setBusy(true)
    try { const report = await loadReport(); if (print) showTableReport(report); else await downloadTableReport(report, csv ? 'csv' : 'xlsx') }
    catch (reason: any) { notifyUser(reason.message || '生成单据失败，请重试') }
    finally { working.current = false; setBusy(false) }
  }
  return <span className="inline-flex flex-wrap gap-2 print:hidden">{!printOnly && <button type="button" disabled={disabled || busy} className="rounded-lg border border-border bg-white px-3 py-2 text-caption disabled:opacity-40" onClick={() => void perform(false)}>{busy ? '生成中…' : csv ? '导出 CSV' : '导出 Excel'}</button>}<button type="button" disabled={disabled || busy} className="rounded-lg border border-border bg-white px-3 py-2 text-caption disabled:opacity-40" onClick={() => void perform(true)}>打印 / 保存 PDF</button></span>
}
export function TableReportHost() {
  const report = useSyncExternalStore(subscribeTableReport, getTableReport, getServerTableReport)
  if (!report) return null
  const print = () => { try { window.print() } catch { notifyUser('当前环境不支持打印，请使用浏览器打开本页') } }
  return <div id="print-report-host" role="dialog" aria-modal="true" aria-label={report.title} className="fixed inset-0 z-[90] overflow-auto bg-white p-4 sm:p-8">
    <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } body > :not(#print-report-host) { display:none !important; } #print-report-host { position:static !important; overflow:visible !important; padding:0 !important; } #print-report-host .report-controls { display:none !important; } #print-report-host .overflow-x-auto { overflow:visible !important; } #print-report-host table { width:100%; font-size:10pt; } #print-report-host thead { display:table-header-group; } #print-report-host tr { break-inside:avoid; } #print-report-host td { overflow-wrap:anywhere; } }`}</style>
    <div className="report-controls mb-5 flex flex-wrap items-center gap-3"><button className="rounded-lg bg-ink px-4 py-2 text-white" onClick={print}>打印</button><button className="rounded-lg border px-4 py-2" onClick={print}>保存 PDF</button><button className="rounded-lg border px-4 py-2" onClick={() => showTableReport(null)}>关闭预览</button><span className="text-caption text-gray2">保存 PDF：在系统打印窗口选择“存储为 PDF / 另存为 PDF”。</span></div>
    <h1 className="text-h1">{report.title}</h1>{report.subtitle && <p className="my-3 whitespace-pre-wrap text-caption">{report.subtitle}</p>}
    <p className="my-2 text-micro text-gray3">共 {report.rows.length} 行 · 生成于 {new Date().toLocaleString('zh-CN')}</p>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-caption"><thead><tr>{report.headers.map((header, index) => <th key={index} className="border border-gray3 bg-bg p-2">{header}</th>)}</tr></thead><tbody>{report.rows.map((row, index) => <tr key={index}>{report.headers.map((_, column) => <td key={column} className="border border-border p-2 align-top">{row[column] ?? '—'}</td>)}</tr>)}</tbody></table></div>
  </div>
}
