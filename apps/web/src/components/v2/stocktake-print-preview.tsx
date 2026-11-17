'use client'

import { useEffect, useRef, useState } from 'react'

export type StocktakePrintDocument = {
  id: string
  no: string
  countDate: string
  status: string
  reviewStatus: string
  warehouse: { code: string; name: string }
  totalBookValue: string
  totalCountedValue: string
  totalDifferenceValue: string
  note: string | null
  items: Array<{
    id: string
    section: string
    assignee: string | null
    productCode: string
    productName: string
    productSpec: string | null
    storageLocation: string | null
    additionSource: 'LEGACY' | 'SYSTEM' | 'PLAN' | 'RECOUNT' | 'MANUAL' | 'MERGED'
    inventoryUnit: string
    bookQuantity: string
    countedQuantity: string | null
    differenceQuantity: string | null
    differenceValue: string | null
    reason: string | null
  }>
}

const statusLabel: Record<string, string> = { DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消' }
const additionSourceLabel: Record<string, string> = { LEGACY: '历史数据', SYSTEM: '系统圈定', PLAN: '盘点方案', RECOUNT: '复盘补充', MANUAL: '手工添加', MERGED: '多人汇总' }

export function StocktakePrintPreview({
  documents,
  busy,
  onComplete,
  onAbandon,
}: {
  documents: StocktakePrintDocument[]
  busy: boolean
  onComplete: () => Promise<void>
  onAbandon: () => Promise<void>
}) {
  const completing = useRef(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const afterPrint = () => {
      if (completing.current) return
      completing.current = true
      setNotice('正在确认打印流程…')
      void onComplete().finally(() => { completing.current = false })
    }
    window.addEventListener('afterprint', afterPrint)
    return () => window.removeEventListener('afterprint', afterPrint)
  }, [onComplete])
  return <section data-stocktake-print-root className="fixed inset-0 z-[100] overflow-auto bg-white p-5" role="dialog" aria-modal="true" aria-label="所选盘点单打印预览">
    <style>{`@media print { @page { size:A4 landscape; margin:10mm } body * { visibility:hidden !important } [data-stocktake-print-root], [data-stocktake-print-root] * { visibility:visible !important } [data-stocktake-print-root] { position:absolute !important; inset:0 !important; overflow:visible !important; padding:0 !important } [data-stocktake-print-controls] { display:none !important } [data-stocktake-print-document] { break-after:page; page-break-after:always } [data-stocktake-print-document]:last-child { break-after:auto; page-break-after:auto } [data-stocktake-print-root] table { width:100%; border-collapse:collapse; font-size:9pt } [data-stocktake-print-root] th, [data-stocktake-print-root] td { border:1px solid #bbb; padding:3px; overflow-wrap:anywhere } [data-stocktake-print-root] thead { display:table-header-group } [data-stocktake-print-root] tr { break-inside:avoid } }`}</style>
    <header data-stocktake-print-controls className="sticky top-0 mb-4 flex flex-wrap items-center gap-3 border bg-white p-3"><strong>盘点单打印预览（{documents.length} 张）</strong><span className="text-caption text-gray2">“已打印”只表示当前版本完成过浏览器打印流程，不代表打印机已实际出纸。</span><button disabled={busy} onClick={() => window.print()}>打印 / 保存 PDF</button><button disabled={busy} onClick={() => void onAbandon()}>关闭并放弃</button>{notice && <span role="status">{notice}</span>}</header>
    {documents.map(document => <article data-stocktake-print-document key={document.id} className="mb-8"><h1 className="text-h1">盘点单 {document.no}</h1><p>仓库：{document.warehouse.name}{document.warehouse.code ? ` · ${document.warehouse.code}` : ''}　盘点日期：{document.countDate}　状态：{statusLabel[document.status] || document.status}</p><p>账面金额：{document.totalBookValue}　实盘金额：{document.totalCountedValue}　差异金额：{document.totalDifferenceValue}　备注：{document.note || '—'}</p><table className="mt-3 w-full border-collapse text-caption"><thead><tr>{['分区', '负责人', '商品编码', '商品', '规格', '库位', '添加方式', '库存单位', '账面数量', '实盘数量', '差异数量', '差异金额', '原因'].map(label => <th className="border p-1" key={label}>{label}</th>)}</tr></thead><tbody>{document.items.map(item => <tr key={item.id}><td className="border p-1">{item.section}</td><td className="border p-1">{item.assignee || '—'}</td><td className="border p-1">{item.productCode}</td><td className="border p-1">{item.productName}</td><td className="border p-1">{item.productSpec || '—'}</td><td className="border p-1">{item.storageLocation || '—'}</td><td className="border p-1">{additionSourceLabel[item.additionSource] || item.additionSource}</td><td className="border p-1">{item.inventoryUnit}</td><td className="border p-1">{item.bookQuantity}</td><td className="border p-1">{item.countedQuantity ?? '未盘'}</td><td className="border p-1">{item.differenceQuantity ?? '—'}</td><td className="border p-1">{item.differenceValue ?? '—'}</td><td className="border p-1">{item.reason || '—'}</td></tr>)}</tbody></table></article>)}
  </section>
}
