'use client'

import Link from 'next/link'
import { createPortal, flushSync } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '@/lib/v2-auth'

type CountItem = {
  id: string
  productCodeSnapshot: string | null
  productNameSnapshot: string | null
  productSpecSnapshot: string | null
  unitSnapshot: string | null
  bookQuantity: number
  countedQuantity: number | null
  differenceQuantity: number | null
  differenceAmount: number | null
  reasonCode: string | null
  reasonNote: string | null
  evidenceKeys: string[] | null
  evidenceUrls: string[] | null
}

type Count = {
  no: string
  countDate: string
  status: string
  totalDifferenceValue: number
  store: { name: string } | null
  items: CountItem[]
}

const number = (value: unknown) => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 })
const money = (value: unknown) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const COUNT_STATUS: Record<string, string> = {
  DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消', REVERSED: '已冲销',
}
const REASON_LABELS: Record<string, string> = {
  WEIGHING: '称重/计量差异', SPOILAGE: '变质损耗', WASTE: '加工损耗', UNRECORDED: '漏记领用/入库', BREAKAGE: '破损/撒漏', OTHER: '其他',
}

const statusLabel = (status: string) => COUNT_STATUS[status] || status
const reasonLabel = (reasonCode: string | null) => reasonCode ? (REASON_LABELS[reasonCode] || reasonCode) : '—'
const evidenceCount = (item: CountItem) => item.evidenceKeys?.length ?? item.evidenceUrls?.length ?? 0
// Safari's native print pipeline can reserve a little more vertical space than
// the CSS @page box reports (printer imageable area and preview rounding). Keep
// a conservative safety band below the nominal A4 landscape content height so
// Safari cannot move the final table row onto an otherwise blank physical
// sheet. The rows are still measured; this reserve only starts a new logical
// page one row earlier when the printer imageable area is smaller than CSS.
const PRINTABLE_PAGE_HEIGHT_PX = 610

type PrintRow = {
  item: CountItem
  productText: string
  reasonText: string
  continuation: boolean
}
type PreparedPrint = { key: string; pages: PrintRow[][] }
type MeasuredPrintRow = { row: PrintRow; height: number }

function PrintHeader({ count, scope, continuation = false }: { count: Count; scope: string; continuation?: boolean }) {
  return <header data-stocktake-print-header="true" className="stocktake-print-document-header"><p>供应链 / 盘点复盘（只读打印件）{continuation ? '（续页）' : ''}</p><h1>{count.no} · {count.store?.name || '—'}</h1><p>盘点日期 {count.countDate} · 状态 {statusLabel(count.status)}</p><p>打印范围：{scope}{continuation ? '' : `；整单差异金额：¥${money(count.totalDifferenceValue)}（非当前筛选合计）`}</p></header>
}

const productText = (item: CountItem) => `${item.productNameSnapshot || '—'}${item.productSpecSnapshot ? ` ${item.productSpecSnapshot}` : ''}`
const reasonText = (item: CountItem) => `${reasonLabel(item.reasonCode)}${item.reasonNote ? ` ${item.reasonNote}` : ''}`
const fullPrintRow = (item: CountItem): PrintRow => ({ item, productText: productText(item), reasonText: reasonText(item), continuation: false })

function ReviewTable({ items, printable = false, printRows }: { items: CountItem[]; printable?: boolean; printRows?: PrintRow[] }) {
  const rows = printRows || items.map(fullPrintRow)
  return <table className={`${printable ? 'w-full' : 'min-w-[980px]'} border-collapse text-left text-caption`}>
    {printable && <colgroup><col style={{ width: '10%' }} /><col style={{ width: '18%' }} /><col style={{ width: '5%' }} /><col style={{ width: '7%' }} /><col style={{ width: '7%' }} /><col style={{ width: '8%' }} /><col style={{ width: '10%' }} /><col style={{ width: '29%' }} /><col style={{ width: '6%' }} /></colgroup>}
    <thead><tr className="border-b border-gray3 bg-bg"><th className="px-3 py-2">编码</th><th className="px-3 py-2">商品 / 规格</th><th className="px-3 py-2">单位</th><th className="px-3 py-2 text-right">账面</th><th className="px-3 py-2 text-right">实盘</th><th className="px-3 py-2 text-right">差异数量</th><th className="px-3 py-2 text-right">差异金额</th><th className="px-3 py-2">原因说明</th><th className="px-3 py-2 text-right">证据</th></tr></thead>
    <tbody>{(printable ? rows : items.map(fullPrintRow)).map(({ item, productText: printedProduct, reasonText: printedReason, continuation }, index) => <tr key={`${item.id}-${index}`} className="border-b border-border align-top">
      <td className="px-3 py-2">{item.productCodeSnapshot || '—'}{continuation ? '（续）' : ''}</td><td className="px-3 py-2">{printedProduct || '（续）'}</td><td className="px-3 py-2">{item.unitSnapshot || '—'}</td><td className="px-3 py-2 text-right font-num">{continuation ? '—' : number(item.bookQuantity)}</td>
      <td className="px-3 py-2 text-right font-num">{continuation ? '—' : item.countedQuantity == null ? '未盘' : number(item.countedQuantity)}</td><td className="px-3 py-2 text-right font-num">{continuation ? '—' : item.differenceQuantity == null ? '—' : number(item.differenceQuantity)}</td><td className="px-3 py-2 text-right font-num">{continuation ? '—' : item.differenceAmount == null ? '—' : `¥${money(item.differenceAmount)}`}</td>
      <td className="px-3 py-2">{printedReason || '（续）'}</td><td className="px-3 py-2 text-right">{continuation ? '—' : `${evidenceCount(item)} 张`}</td>
    </tr>)}</tbody>
  </table>
}

function PrintPage({ count, scope, rows, continuation = false, emptyText }: { count: Count; scope: string; rows: PrintRow[]; continuation?: boolean; emptyText?: string }) {
  return <section className="stocktake-print-page">
    <PrintHeader count={count} scope={scope} continuation={continuation} />
    <ReviewTable items={[]} printRows={rows} printable />
    {emptyText && <p data-stocktake-print-empty="true" className="py-8 text-center text-gray3">{emptyText}</p>}
  </section>
}

export default function StocktakeReviewPrintPage({ params }: { params: { id: string } }) {
  const [count, setCount] = useState<Count | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [onlyDifference, setOnlyDifference] = useState(true)
  const [preparedPrint, setPreparedPrint] = useState<PreparedPrint | null>(null)
  const [fragmentProbe, setFragmentProbe] = useState<PrintRow | null>(null)
  const printMeasureRef = useRef<HTMLElement | null>(null)
  const fragmentMeasureRef = useRef<HTMLElement | null>(null)
  const printVersionRef = useRef(0)
  const preparedPrintKeyRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    let current = true
    setCount(null)
    setError('')
    apiFetch<Count>(new URLSearchParams(window.location.search).get('source') === 'warehouse' ? `/api/warehouse-stocktakes/${params.id}/review` : `/api/inventory-counts/${params.id}`)
      .then(next => { if (current) setCount(next) })
      .catch(nextError => { if (current) setError(nextError.message || '盘点单加载失败') })
    return () => { current = false }
  }, [params.id])

  const items = useMemo(() => (count?.items || []).filter(item => {
    const text = `${item.productCodeSnapshot || ''} ${item.productNameSnapshot || ''} ${item.productSpecSnapshot || ''}`.toLowerCase()
    const matches = text.includes(query.trim().toLowerCase())
    // 未盘数量为 null，绝不把它当作零差异或零库存。
    return matches && (!onlyDifference || (item.countedQuantity != null && Number(item.differenceQuantity) !== 0))
  }), [count, onlyDifference, query])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      printVersionRef.current += 1
    }
  }, [])

  useEffect(() => {
    // A prepared document belongs to exactly one loaded count and filter state.
    // Invalidate it before an async print can commit stale rows into the portal.
    printVersionRef.current += 1
    preparedPrintKeyRef.current = null
    setPreparedPrint(null)
  }, [params.id, count, query, onlyDifference])

  const scope = `${onlyDifference ? '仅已盘且有差异' : '全部明细'}${query.trim() ? `；搜索“${query.trim()}”` : ''}（${items.length} 项）`
  const emptyText = onlyDifference ? '没有已盘且有差异的明细' : '没有符合条件的明细'
  const printKey = count ? `${params.id}\u0000${count.no}\u0000${scope}\u0000${items.map(item => item.id).join('\u0001')}` : ''
  const pageRows = preparedPrint?.key === printKey ? preparedPrint.pages : [items.map(fullPrintRow)]
  const pageMetrics = (measure: HTMLElement | null) => {
    const pageTop = measure?.querySelector('.stocktake-print-page')?.getBoundingClientRect().top || 0
    const rowHeights = Array.from(measure?.querySelectorAll('tbody tr') || []).map(row => row.getBoundingClientRect().height)
    const firstRowTop = measure?.querySelector('tbody tr')?.getBoundingClientRect().top
    // The first row's offset includes the document header, table header and the
    // real 16px header margin. getBoundingClientRect(header).height does not.
    return { availableHeight: firstRowTop == null ? 0 : Math.max(1, PRINTABLE_PAGE_HEIGHT_PX - (firstRowTop - pageTop)), rowHeights }
  }
  const measureFragment = (row: PrintRow) => {
    flushSync(() => setFragmentProbe(row))
    return pageMetrics(fragmentMeasureRef.current).rowHeights[0] || 0
  }
  const splitOversizedRow = (item: CountItem, availableHeight: number): MeasuredPrintRow[] => {
    const product = Array.from(productText(item))
    const reason = Array.from(reasonText(item))
    const tokens: Array<{ product?: string; reason?: string }> = []
    for (let index = 0; index < Math.max(product.length, reason.length); index += 1) {
      if (product[index] != null) tokens.push({ product: product[index] })
      if (reason[index] != null) tokens.push({ reason: reason[index] })
    }
    const makeRow = (start: number, length: number, continuation: boolean): PrintRow => {
      const part = tokens.slice(start, start + length)
      return { item, productText: part.map(token => token.product || '').join(''), reasonText: part.map(token => token.reason || '').join(''), continuation }
    }
    const rows: MeasuredPrintRow[] = []
    let start = 0
    let fragments = 0
    // Each iteration consumes at least one Unicode code point. The cap makes a
    // malformed DOM measurement fail safe instead of looping during printing.
    while (start < tokens.length && fragments < tokens.length) {
      let low = 1
      let high = tokens.length - start
      let accepted = 0
      let acceptedHeight = 0
      while (low <= high) {
        const length = Math.floor((low + high) / 2)
        const row = makeRow(start, length, fragments > 0)
        const height = measureFragment(row)
        if (height > 0 && height <= availableHeight) {
          accepted = length
          acceptedHeight = height
          low = length + 1
        } else high = length - 1
      }
      if (!accepted) {
        const row = makeRow(start, 1, fragments > 0)
        const height = measureFragment(row)
        // This can only happen if the fixed identifier cells alone exceed a
        // physical page. Keep one code point and make forward progress.
        rows.push({ row, height: height || availableHeight + 1 })
        start += 1
      } else {
        rows.push({ row: makeRow(start, accepted, fragments > 0), height: acceptedHeight })
        start += accepted
      }
      fragments += 1
    }
    return rows
  }
  const makePrintPages = (printItems: CountItem[]) => {
    const metrics = pageMetrics(printMeasureRef.current)
    if (metrics.rowHeights.length !== printItems.length || metrics.rowHeights.some(height => height <= 0) || !metrics.availableHeight) return [printItems.map(fullPrintRow)]
    const measuredRows = printItems.flatMap((item, index) => {
      const height = metrics.rowHeights[index]
      return height > metrics.availableHeight ? splitOversizedRow(item, metrics.availableHeight) : [{ row: fullPrintRow(item), height }]
    })
    const pages: PrintRow[][] = []
    let page: PrintRow[] = []
    let usedHeight = 0
    measuredRows.forEach(({ row, height }) => {
      if (page.length && usedHeight + height > metrics.availableHeight) {
        pages.push(page)
        page = []
        usedHeight = 0
      }
      page.push(row)
      usedHeight += height
    })
    if (page.length || !pages.length) pages.push(page)
    return pages
  }
  const waitForFrame = () => new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
  const preparePrint = () => {
    if (!count) return
    if (preparedPrintKeyRef.current === printKey) return
    const nextPrint = { key: printKey, pages: makePrintPages(items) }
    preparedPrintKeyRef.current = printKey
    flushSync(() => {
      setFragmentProbe(null)
      setPreparedPrint(nextPrint)
    })
  }
  const print = async () => {
    // Safari resolves document.fonts only after the printable typeface is ready.
    // Then flush the page groups and allow two frames for the portal to lay out.
    const version = printVersionRef.current
    await (document.fonts?.ready || Promise.resolve())
    if (!mountedRef.current || version !== printVersionRef.current) return
    preparePrint()
    await waitForFrame()
    if (!mountedRef.current || version !== printVersionRef.current) return
    await waitForFrame()
    if (!mountedRef.current || version !== printVersionRef.current) return
    window.print()
  }
  useEffect(() => {
    // The native Cmd+P route does not call the button handler. beforeprint is
    // synchronous, so it can still replace the portal with measured page groups.
    const beforePrint = () => preparePrint()
    window.addEventListener('beforeprint', beforePrint)
    return () => window.removeEventListener('beforeprint', beforePrint)
  }, [printKey])
  if (error) return <main className="p-6 text-red-fg">{error}</main>
  if (!count) return <main className="p-6 text-gray3">加载盘点复盘…</main>
  const printRoot = <section data-stocktake-print="true" className="stocktake-print-root">
    {pageRows.map((page, index) => <PrintPage key={index} count={count} scope={scope} rows={page} continuation={index > 0} emptyText={!items.length ? emptyText : undefined} />)}
  </section>
  const printMeasure = <section ref={printMeasureRef} data-stocktake-print-measure="true" aria-hidden="true"><PrintPage count={count} scope={scope} rows={items.map(fullPrintRow)} /></section>
  const fragmentMeasure = fragmentProbe && <section ref={fragmentMeasureRef} data-stocktake-fragment-measure="true" aria-hidden="true"><PrintPage count={count} scope={scope} rows={[fragmentProbe]} /></section>

  return <>
    <style>{`[data-stocktake-print], [data-stocktake-print-measure], [data-stocktake-fragment-measure] { color:#111; background:#fff; font-family:Arial, "PingFang SC", sans-serif; font-size:10pt; line-height:1.3 } [data-stocktake-print] h1, [data-stocktake-print-measure] h1, [data-stocktake-fragment-measure] h1 { margin:0; font-size:16pt; line-height:1.25 } [data-stocktake-print] p, [data-stocktake-print-measure] p, [data-stocktake-fragment-measure] p { margin:2px 0 } [data-stocktake-print] .stocktake-print-document-header, [data-stocktake-print-measure] .stocktake-print-document-header, [data-stocktake-fragment-measure] .stocktake-print-document-header { margin:0 0 16px } [data-stocktake-print] table, [data-stocktake-print-measure] table, [data-stocktake-fragment-measure] table { width:100%; table-layout:fixed; border-collapse:collapse; font-size:9pt } [data-stocktake-print] td, [data-stocktake-print] th, [data-stocktake-print-measure] td, [data-stocktake-print-measure] th, [data-stocktake-fragment-measure] td, [data-stocktake-fragment-measure] th { white-space:normal; overflow:visible; overflow-wrap:anywhere; text-overflow:clip; vertical-align:top; padding:2px 3px } @media screen { [data-stocktake-print] { display:none } [data-stocktake-print-measure], [data-stocktake-fragment-measure] { display:block; position:absolute; visibility:hidden; left:-100000px; top:0; width:1046px; padding:0; pointer-events:none } } @media print { @page { size:A4 landscape; margin:10mm } body > *:not([data-stocktake-print]) { display:none !important } body > [data-stocktake-print] { display:block !important; width:100% !important; padding:0 !important } body > [data-stocktake-print-measure], body > [data-stocktake-fragment-measure] { display:block !important; position:fixed !important; visibility:hidden !important; left:-100000px !important; top:0 !important; width:277mm !important; padding:0 !important; pointer-events:none !important } [data-stocktake-print] .stocktake-print-page { break-after:page; page-break-after:always } [data-stocktake-print] .stocktake-print-page:last-child { break-after:auto; page-break-after:auto } [data-stocktake-print] thead { display:table-header-group !important } [data-stocktake-print] tr { break-inside:avoid !important; page-break-inside:avoid !important } }`}</style>
    <main className="mx-auto max-w-6xl p-4 pb-24 text-gray1 lg:pb-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><p className="text-caption text-gray3">供应链 / 盘点复盘（只读）</p><h1 className="text-h1">{count.no} · {count.store?.name || '—'}</h1><p className="text-caption text-gray3">盘点日期 {count.countDate} · 状态 {statusLabel(count.status)}</p></div><div className="flex items-center gap-3"><Link href="/v2/supply-chain/stocktake/count" className="text-caption underline">返回盘点管理</Link><button type="button" onClick={() => { void print() }} className="rounded-cta bg-amber px-4 py-2 text-white">打印复盘单</button></div></header>
      <section className="mb-3 flex flex-wrap gap-2"><input aria-label="搜索盘点商品" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索编码、名称、规格" className="rounded-cta border border-border px-3 py-2" /><button type="button" aria-pressed={onlyDifference} onClick={() => setOnlyDifference(true)} className="rounded-cta border px-3 py-2">仅看差异</button><button type="button" aria-pressed={!onlyDifference} onClick={() => setOnlyDifference(false)} className="rounded-cta border px-3 py-2">全部明细</button></section>
      <section className="mb-3 rounded-card border border-border p-3 text-caption"><b>机构：</b>{count.store?.name || '—'}　<b>单号：</b>{count.no}　<b>日期：</b>{count.countDate}　<b>状态：</b>{statusLabel(count.status)}<br /><span>当前查看：{scope}；整单差异金额：¥{money(count.totalDifferenceValue)}（非当前筛选合计）</span></section>
      <div className="overflow-x-auto"><ReviewTable items={items} /></div>
      {!items.length && <p className="py-8 text-center text-gray3">{emptyText}</p>}
    </main>
    {createPortal(printRoot, document.body)}
    {createPortal(printMeasure, document.body)}
    {fragmentMeasure && createPortal(fragmentMeasure, document.body)}
  </>
}
