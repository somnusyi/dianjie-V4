import { partitionDeliveryNoteRows } from './delivery-note-print'

/** A body-level snapshot keeps navigation, sticky cells and scroll containers off paper. */
export function prepareTablePrint(source: HTMLElement, documentSelector?: string, options: {fontSize?:9|10|11;orientation?:'landscape'|'portrait'} = {}): () => void {
  const portrait = options.orientation === 'portrait'
  const fontSize = [9,10,11].includes(options.fontSize || 9) ? options.fontSize || 9 : 9
  document.querySelector('[data-table-print-root]')?.remove()
  const style = document.createElement('style')
  style.textContent = `
    [data-table-print-root] { display:none }
    [data-table-print-document] { color:#111!important; background:#fff!important; font:10pt/1.3 Arial,"PingFang SC",sans-serif!important }
    [data-table-print-document] [data-receipt-paper] { box-sizing:border-box!important; width:100%!important; min-height:0!important; max-width:none!important; padding:0!important; margin:0!important; box-shadow:none!important }
    [data-table-print-document] table { width:100%!important; table-layout:fixed!important; border-collapse:collapse!important; font-size:${fontSize}pt!important }
    [data-table-print-document] th,[data-table-print-document] td { position:static!important; white-space:normal!important; overflow:visible!important; overflow-wrap:anywhere!important; text-overflow:clip!important; border:1px solid #999!important; padding:3px!important; vertical-align:top!important; line-height:1.3!important }
    [data-table-print-document] h1 { font-size:16pt!important; margin:0 0 8px!important }
    @media print { @page { size:A4 ${portrait?'portrait':'landscape'}; margin:10mm }
      body:has([data-table-print-root]) > :not([data-table-print-root]) { display:none!important }
      body > [data-table-print-root] { display:block!important }
      [data-table-print-page] { break-after:page; page-break-after:always }
      [data-table-print-page]:last-child { break-after:auto; page-break-after:auto }
    }`
  document.head.appendChild(style)
  const root = document.createElement('div')
  root.setAttribute('data-table-print-root', '')
  const normalize = (node: HTMLElement) => {
    node.removeAttribute('id')
    node.removeAttribute('role')
    node.removeAttribute('aria-modal')
    node.setAttribute('data-table-print-document', '')
    if (node.querySelector('[data-receipt-letterhead]')) node.style.setProperty('font-family', 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', 'important')
    const properties: Record<string,string> = { display:'block',position:'static',inset:'auto',width:portrait?'190mm':'277mm',maxWidth:'none',height:'auto',minHeight:'0',maxHeight:'none',padding:'0',margin:'0',overflow:'visible',border:'0',borderRadius:'0',boxShadow:'none' }
    for (const [key,value] of Object.entries(properties)) node.style.setProperty(key.replace(/[A-Z]/g, c => '-'+c.toLowerCase()), value, 'important')
    node.querySelectorAll('[data-print-hidden],.report-controls,[data-management-print-controls]').forEach(n => n.remove())
  }
  try {
    const documents = documentSelector ? Array.from(source.querySelectorAll<HTMLElement>(documentSelector)) : [source]
    for (const original of documents) {
      const measure = original.cloneNode(true) as HTMLElement
      normalize(measure)
      measure.style.setProperty('position', 'fixed', 'important')
      measure.style.setProperty('left', '-100000px', 'important')
      measure.style.visibility = 'hidden'
      document.body.appendChild(measure)
      let pages: number[][]
      try {
        const table = measure.querySelector('table')
        const rows = Array.from(table?.querySelectorAll('tbody > tr') || [])
        const head = (rows.length ? rows[0].getBoundingClientRect().top : table?.getBoundingClientRect().bottom || measure.getBoundingClientRect().top) - measure.getBoundingClientRect().top
        if (head >= (portrait ? 930 : 610) - 24) throw new Error('模板抬头过高，请减少表格行数、文字或字号后再打印')
        const capacity = (portrait ? 930 : 610) - head - 24
        const heights = rows.map(row => row.getBoundingClientRect().height)
        const tail = table?.querySelector('tfoot')?.getBoundingClientRect().height || 0
        if (tail > capacity) throw new Error('模板合计或签字栏过高，请减少文字或字号后再打印')
        pages = partitionDeliveryNoteRows(heights, capacity)
        const last = pages[pages.length - 1]
        if (last.reduce((sum, index) => sum + heights[index], 0) + tail > capacity) {
          // Move enough final rows together so the total/signatures stay on one page.
          const finalRows: number[] = []
          let used = tail
          while (last.length && used + heights[last[last.length - 1]] <= capacity) {
            const index = last.pop()!
            finalRows.unshift(index)
            used += heights[index]
          }
          pages.push(finalRows)
        }
      } finally { measure.remove() }
      pages.forEach((indexes,pageIndex) => {
        const page = original.cloneNode(true) as HTMLElement
        normalize(page)
        page.setAttribute('data-table-print-page', '')
        page.style.setProperty('width', '100%', 'important')
        const table = page.querySelector('table')
        const keep = new Set(indexes)
        table?.querySelectorAll('tbody > tr').forEach((row,index) => { if (!keep.has(index)) row.remove() })
        if (pageIndex < pages.length - 1) table?.querySelector('tfoot')?.remove()
        const label = document.createElement('p')
        label.textContent = `第 ${pageIndex+1} 页 / 共 ${pages.length} 页`
        label.style.cssText = 'font-size:9px;text-align:right;margin-top:8px'
        page.appendChild(label)
        root.appendChild(page)
      })
    }
    document.body.appendChild(root)
  } catch (error) { style.remove(); root.remove(); throw error }
  return () => { root.remove(); style.remove() }
}
