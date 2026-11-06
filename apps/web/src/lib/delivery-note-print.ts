/** Build independent A4 pages because WebKit may split table row groups. */
export function partitionDeliveryNoteRows(heights: number[], capacity: number): number[][] {
  if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('送货单抬头或备注过长，请缩短后打印')
  const pages: number[][] = [[]]
  let used = 0
  heights.forEach((height, index) => {
    if (pages[pages.length - 1].length && used + height > capacity) { pages.push([]); used = 0 }
    pages[pages.length - 1].push(index)
    used += height
  })
  return pages
}

/** First-page metadata consumes space once; continuation pages only keep column headings. */
export function planDeliveryNotePages(heights: number[], firstCapacity: number, continuationCapacity: number, tail: number): number[][] {
  if (![firstCapacity, continuationCapacity].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(tail) || tail < 0 || tail > continuationCapacity) {
    throw new Error('送货单抬头或备注过长，请缩短后打印')
  }
  const groups: number[][] = [[]]
  let used = 0
  for (let index = 0; index < heights.length; index++) {
    const height = heights[index]
    if (!Number.isFinite(height) || height < 0 || height > continuationCapacity) throw new Error('商品名称或规格过长，单行超出纸面')
    const capacity = groups.length === 1 ? firstCapacity : continuationCapacity
    if (used + height > capacity) { groups.push([]); used = 0 }
    groups[groups.length - 1].push(index)
    used += height
  }
  const last = groups[groups.length - 1]
  const capacity = groups.length === 1 ? firstCapacity : continuationCapacity
  if (last.reduce((sum, index) => sum + heights[index], 0) + tail > capacity) {
    if (last.length > 1 && heights[last[last.length - 1]] + tail <= continuationCapacity) groups.push([last.pop()!])
    else groups.push([])
  }
  return groups
}

function normalizePaper(page: HTMLElement) {
  page.removeAttribute('id')
  Object.assign(page.style, { width: '186mm', minHeight: '0', height: 'auto', padding: '0', margin: '0', boxShadow: 'none' })
}

/** Shared actual layout for generated PDF and native browser printing. No print side effects. */
export function buildDeliveryNotePages(source: HTMLElement): HTMLElement {
  const measure = source.cloneNode(true) as HTMLElement
  normalizePaper(measure)
  measure.setAttribute('data-delivery-note-print-measure', '')
  Object.assign(measure.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden' })
  document.body.appendChild(measure)
  let groups: number[][]
  try {
    const header = measure.querySelector<HTMLElement>('[data-delivery-note-header]')
    const references = measure.querySelector<HTMLElement>('[data-delivery-note-references]')
    // Extra order numbers may wrap; keep the remaining metadata compact without capping their lines.
    const referenceLineHeight = references ? parseFloat(getComputedStyle(references).lineHeight) || 18 : 18
    const extraReferenceHeight = Math.max(0, (references?.getBoundingClientRect().height || 0) - referenceLineHeight)
    if (header && header.getBoundingClientRect().height - extraReferenceHeight > 273 * 96 / 25.4 / 4) {
      throw new Error('送货单上方信息超过四分之一页，请精简信息或拆分集合单据')
    }
    if (Array.from(measure.querySelectorAll<HTMLElement>('.delivery-contact')).some(node => node.scrollWidth > node.clientWidth + 1)) {
      throw new Error('联系人信息过长，请缩短联系人名称后生成')
    }
    const rows = Array.from(measure.querySelectorAll<HTMLElement>('[data-delivery-note-row]'))
    const headHeight = () => (rows[0] || measure.querySelector('thead'))!.getBoundingClientRect()[rows.length ? 'top' : 'bottom'] - measure.getBoundingClientRect().top
    const firstHeader = headHeight()
    const tail = measure.getBoundingClientRect().bottom - (rows[rows.length - 1] || measure.querySelector('thead'))!.getBoundingClientRect().bottom
    const heights = rows.map(row => row.getBoundingClientRect().height)
    header?.remove()
    const continuationHeader = headHeight()
    const pageCapacity = 273 * 96 / 25.4 - 28
    groups = planDeliveryNotePages(heights, pageCapacity - firstHeader, pageCapacity - continuationHeader, tail)
  } finally { measure.remove() }
  const root = document.createElement('div')
  groups.forEach((indexes, pageIndex) => {
    const page = source.cloneNode(true) as HTMLElement
    normalizePaper(page)
    page.classList.add('delivery-note-print-page')
    if (pageIndex > 0) page.querySelector('[data-delivery-note-header]')?.remove()
    const keep = new Set(indexes)
    page.querySelectorAll('[data-delivery-note-row]').forEach((row, index) => { if (!keep.has(index)) row.remove() })
    if (pageIndex !== groups.length - 1) {
      page.querySelector('[data-delivery-note-totals]')?.remove()
      page.querySelector('[data-delivery-note-footer]')?.remove()
    }
    const number = document.createElement('div')
    number.setAttribute('data-delivery-note-page-number', '')
    number.textContent = `第 ${pageIndex + 1} 页 / 共 ${groups.length} 页`
    page.appendChild(number)
    root.appendChild(page)
  })
  return root
}

export function prepareDeliveryNotePrint(source: HTMLElement): () => void {
  document.querySelector('[data-delivery-note-print-root]')?.remove()
  const root = buildDeliveryNotePages(source)
  root.setAttribute('data-delivery-note-print-root', '')
  document.body.appendChild(root)
  return () => root.remove()
}
